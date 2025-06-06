const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const epub = require('epub');
const { createServer } = require('http');
const { Server } = require('socket.io');
const os = require('os');
const ffprobe = require('node-ffprobe');
const { spawn } = require('child_process');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

// Create temp directory for audio files
const tempDir = path.join(os.tmpdir(), 'tts-temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir);
}

// Middleware
app.use(cors());
app.use(express.json());

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// Function to extract text from PDF
async function extractTextFromPDF(filePath) {
  console.log('Extracting text from PDF:', filePath);
  const dataBuffer = fs.readFileSync(filePath);
  const data = await pdfParse(dataBuffer);
  
  // For PDFs, we'll create artificial chapters based on page numbers
  const pages = data.numpages;
  console.log('PDF pages:', pages);
  const chapters = [];
  const chapterSize = Math.ceil(pages / 10); // Divide into roughly 10 chapters
  
  for (let i = 0; i < pages; i += chapterSize) {
    chapters.push({
      title: `Chapter ${Math.floor(i / chapterSize) + 1}`,
      startPage: i + 1,
      endPage: Math.min(i + chapterSize, pages)
    });
  }
  
  console.log('PDF chapters:', chapters);
  return {
    text: data.text,
    chapters: chapters,
    title: path.basename(filePath, '.pdf')
  };
}

const EPub = require('epub');

// Function to extract text from EPUB
function extractTextFromEPUB(filePath) {
  console.log('Extracting text from EPUB:', filePath);
  return new Promise((resolve, reject) => {
    const epubBook = new EPub(filePath);
    let chapters = [];
    let fullText = '';
    let bookTitle = '';

    epubBook.on('end', () => {
      const metadata = epubBook.metadata;
      console.log('EPUB metadata:', metadata);
      bookTitle = metadata.title || path.basename(filePath, '.epub');

      // Get all chapters
      if (epubBook.flow && epubBook.flow.length > 0) {
        console.log('EPUB flow items:', epubBook.flow.length);
        epubBook.flow.forEach((item, index) => {
          // Skip very short or empty titles that are likely non-chapter
          if (!item.title || item.title.toLowerCase().includes("chapter") || item.title.length > 5) {
            chapters.push({
              title: item.title || `Chapter ${index + 1}`,
              id: item.id
            });
          }
        });
      } else {
        // If no flow items, create chapters based on spine
        console.log('No flow items, using spine');
        if (epubBook.spine && epubBook.spine.length > 0) {
          epubBook.spine.forEach((item, index) => {
            chapters.push({
              title: `Chapter ${index + 1}`,
              id: item.idref
            });
          });
        }
      }

      console.log('EPUB chapters:', chapters);

      // Get first chapter content
      const chapterId = chapters.length > 0 ? chapters[0].id : null;
      if (!chapterId) {
        console.log('No chapters found in EPUB');
        return reject(new Error('No chapters found'));
      }

      epubBook.getChapter(chapterId, (err, chapterText) => {
        if (err) {
          console.error('Error getting chapter:', err);
          return reject(err);
        }

        const cleanText = chapterText
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        fullText = cleanText;
        resolve({
          text: fullText,
          chapters: chapters,
          title: bookTitle
        });
      });
    });

    epubBook.on('error', (err) => {
      console.error('EPUB error:', err);
      reject(err);
    });

    epubBook.parse();
  });
}

// Function to convert text to speech using gTTS
const textToSpeech = async (text, socket) => {
  try {
    socket.emit('ttsProgress', { progress: 0, status: 'Starting text-to-speech conversion...' });

    // Split text into smaller chunks (approximately 50 words each for faster initial playback)
    const words = text.split(/\s+/);
    const chunks = [];
    for (let i = 0; i < words.length; i += 50) {
      chunks.push(words.slice(i, i + 50).join(' '));
    }

    const totalChunks = chunks.length;
    let processedChunks = 0;

    // Process chunks in parallel with a higher concurrency limit
    const concurrencyLimit = 5;
    const results = [];

    // Process first chunk immediately
    const firstChunk = chunks[0];
    const firstOutputFile = path.join(tempDir, 'chunk_0.mp3');
    
    try {
      await new Promise((resolve, reject) => {
        const tts = spawn('gtts-cli', [firstChunk, '--output', firstOutputFile]);
        socket.ttsProcess = tts;

        tts.on('close', (code) => {
          if (code !== 0) {
            reject(new Error('Failed to convert first chunk to speech'));
            return;
          }
          resolve();
        });

        tts.on('error', (err) => {
          reject(err);
        });
      });

      const audioBuffer = await fs.promises.readFile(firstOutputFile);
      const base64Audio = audioBuffer.toString('base64');
      const probeData = await ffprobe(firstOutputFile);
      const duration = probeData.format.duration;

      if (socket.connected) {
        socket.emit('audioChunk', {
          index: 0,
          audioContent: base64Audio,
          type: 'audio/mpeg',
          duration: duration
        });
      }

      // Process remaining chunks
      for (let i = 1; i < chunks.length; i++) {
        if (!socket.connected) break;

        const chunk = chunks[i];
        const outputFile = path.join(tempDir, `chunk_${i}.mp3`);
        
        try {
          await new Promise((resolve, reject) => {
            const tts = spawn('gtts-cli', [chunk, '--output', outputFile]);
            socket.ttsProcess = tts;
            
            tts.on('close', (code) => {
              if (code !== 0) {
                reject(new Error(`Failed to convert chunk ${i} to speech`));
                return;
              }
              resolve();
            });

            tts.on('error', (err) => {
              reject(err);
            });
          });

          const audioBuffer = await fs.promises.readFile(outputFile);
          const base64Audio = audioBuffer.toString('base64');
          const probeData = await ffprobe(outputFile);
          const duration = probeData.format.duration;

          if (socket.connected) {
            socket.emit('audioChunk', {
              index: i,
              audioContent: base64Audio,
              type: 'audio/mpeg',
              duration: duration
            });
          }
        } catch (error) {
          console.error(`Error processing chunk ${i}:`, error);
          if (socket.connected) {
            socket.emit('ttsError', `Error processing chunk ${i}`);
          }
          break;
        }
      }

      if (socket.connected) {
        socket.emit('ttsComplete');
      }
    } catch (error) {
      console.error('Error processing audio chunks:', error);
      if (socket.connected) {
        socket.emit('ttsError', 'Error processing audio chunks');
      }
    } finally {
      // Clean up temp files
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.error('Error cleaning up temp files:', error);
      }
    }
  } catch (error) {
    console.error('Error in textToSpeech:', error);
    socket.emit('ttsError', { error: error.message });
  }
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected');

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected');
    // Clean up any ongoing processes
    if (socket.ttsProcess) {
      socket.ttsProcess.kill();
    }
  });

  // Handle text-to-speech conversion
  socket.on('convertToSpeech', async (data) => {
    try {
      const { text } = data;
      if (!text) {
        socket.emit('ttsError', 'No text provided');
        return;
      }

      // Create temp directory for this session
      const tempDir = path.join(__dirname, 'temp', socket.id);
      await fs.promises.mkdir(tempDir, { recursive: true });

      // Split text into chunks
      const words = text.split(/\s+/);
      const chunks = [];
      for (let i = 0; i < words.length; i += 50) {
        chunks.push(words.slice(i, i + 50).join(' '));
      }

      // Process first chunk immediately
      const firstChunk = chunks[0];
      const firstOutputFile = path.join(tempDir, 'chunk_0.mp3');
      
      try {
        await new Promise((resolve, reject) => {
          const tts = spawn('gtts-cli', [firstChunk, '--output', firstOutputFile]);
          socket.ttsProcess = tts;

          tts.on('close', (code) => {
            if (code !== 0) {
              reject(new Error('Failed to convert first chunk to speech'));
              return;
            }
            resolve();
          });

          tts.on('error', (err) => {
            reject(err);
          });
        });

        const audioBuffer = await fs.promises.readFile(firstOutputFile);
        const base64Audio = audioBuffer.toString('base64');
        const probeData = await ffprobe(firstOutputFile);
        const duration = probeData.format.duration;

        if (socket.connected) {
          socket.emit('audioChunk', {
            index: 0,
            audioContent: base64Audio,
            type: 'audio/mpeg',
            duration: duration
          });
        }

        // Process remaining chunks
        for (let i = 1; i < chunks.length; i++) {
          if (!socket.connected) break;

          const chunk = chunks[i];
          const outputFile = path.join(tempDir, `chunk_${i}.mp3`);
          
          try {
            await new Promise((resolve, reject) => {
              const tts = spawn('gtts-cli', [chunk, '--output', outputFile]);
              socket.ttsProcess = tts;
              
              tts.on('close', (code) => {
                if (code !== 0) {
                  reject(new Error(`Failed to convert chunk ${i} to speech`));
                  return;
                }
                resolve();
              });

              tts.on('error', (err) => {
                reject(err);
              });
            });

            const audioBuffer = await fs.promises.readFile(outputFile);
            const base64Audio = audioBuffer.toString('base64');
            const probeData = await ffprobe(outputFile);
            const duration = probeData.format.duration;

            if (socket.connected) {
              socket.emit('audioChunk', {
                index: i,
                audioContent: base64Audio,
                type: 'audio/mpeg',
                duration: duration
              });
            }
          } catch (error) {
            console.error(`Error processing chunk ${i}:`, error);
            if (socket.connected) {
              socket.emit('ttsError', `Error processing chunk ${i}`);
            }
            break;
          }
        }

        if (socket.connected) {
          socket.emit('ttsComplete');
        }
      } catch (error) {
        console.error('Error processing audio chunks:', error);
        if (socket.connected) {
          socket.emit('ttsError', 'Error processing audio chunks');
        }
      } finally {
        // Clean up temp files
        try {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch (error) {
          console.error('Error cleaning up temp files:', error);
        }
      }
    } catch (error) {
      console.error('Error in textToSpeech:', error);
      if (socket.connected) {
        socket.emit('ttsError', 'Error in text-to-speech conversion');
      }
    }
  });
});

// File upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const fileExt = path.extname(filePath).toLowerCase();

    let result;
    if (fileExt === '.pdf') {
      result = await extractTextFromPDF(filePath);
    } else if (fileExt === '.epub') {
      result = await extractTextFromEPUB(filePath);
    } else {
      return res.status(400).json({ error: 'Unsupported file format' });
    }

    // Store the file ID for later chapter access
    const fileId = path.basename(filePath);
    result.fileId = fileId;

    console.log('Upload result:', {
      fileId: result.fileId,
      title: result.title,
      chaptersCount: result.chapters?.length || 0
    });

    res.json(result);
  } catch (error) {
    console.error('Error processing file:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add cleanup route to remove files when done
app.post("/cleanup/:fileId", (req, res) => {
  try {
    const filePath = path.join('uploads', req.params.fileId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error cleaning up file:', error);
    res.status(500).json({ error: 'Error cleaning up file' });
  }
});

// Add route to get chapter content with streaming
app.get("/chapter/:fileId/:chapterId", async (req, res) => {
  try {
    const { fileId, chapterId } = req.params;
    const filePath = path.join('uploads', fileId);
    const fileExt = path.extname(fileId).toLowerCase();

    // Set headers for streaming
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');

    if (fileExt === '.epub') {
      const epubBook = new EPub(filePath);
      
      epubBook.on('end', () => {
        epubBook.getChapter(chapterId, (err, text) => {
          if (err) {
            res.status(500).json({ error: 'Error getting chapter' });
            return;
          }

          // Clean and split text into chunks
          const cleanText = text
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          const words = cleanText.split(/\s+/);
          const chunkSize = 100; // Number of words per chunk
          const totalChunks = Math.ceil(words.length / chunkSize);

          // Send initial progress
          res.write(JSON.stringify({ 
            type: 'progress',
            progress: 0,
            total: totalChunks
          }) + '\n');

          // Stream chunks with progress updates
          for (let i = 0; i < words.length; i += chunkSize) {
            const chunk = words.slice(i, i + chunkSize).join(' ');
            const progress = Math.floor(i / chunkSize);
            
            res.write(JSON.stringify({
              type: 'chunk',
              text: chunk,
              progress: progress,
              total: totalChunks
            }) + '\n');
          }

          // Send completion message
          res.write(JSON.stringify({
            type: 'complete',
            progress: totalChunks,
            total: totalChunks
          }) + '\n');

          res.end();
        });
      });

      epubBook.on('error', (err) => {
        console.error('EPUB error:', err);
        res.status(500).json({ error: 'Error processing EPUB' });
      });

      epubBook.parse();
    } else if (fileExt === '.pdf') {
      // For PDFs, we'll stream the text in chunks
      const dataBuffer = fs.readFileSync(filePath);
      pdfParse(dataBuffer).then(data => {
        const words = data.text.split(/\s+/);
        const chunkSize = 100; // Number of words per chunk
        const totalChunks = Math.ceil(words.length / chunkSize);

        // Send initial progress
        res.write(JSON.stringify({ 
          type: 'progress',
          progress: 0,
          total: totalChunks
        }) + '\n');

        // Stream chunks with progress updates
        for (let i = 0; i < words.length; i += chunkSize) {
          const chunk = words.slice(i, i + chunkSize).join(' ');
          const progress = Math.floor(i / chunkSize);
          
          res.write(JSON.stringify({
            type: 'chunk',
            text: chunk,
            progress: progress,
            total: totalChunks
          }) + '\n');
        }

        // Send completion message
        res.write(JSON.stringify({
          type: 'complete',
          progress: totalChunks,
          total: totalChunks
        }) + '\n');

        res.end();
      }).catch(err => {
        console.error('PDF error:', err);
        res.status(500).json({ error: 'Error processing PDF' });
      });
    }
  } catch (error) {
    console.error('Error getting chapter:', error);
    res.status(500).json({ error: 'Error getting chapter content' });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 