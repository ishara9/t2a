import { useState, useEffect, useRef } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'
import io from 'socket.io-client';

function App() {
  const [text, setText] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentWord, setCurrentWord] = useState('');
  const [uploading, setUploading] = useState(false);
  const [chapters, setChapters] = useState([]);
  const [currentFileId, setCurrentFileId] = useState(null);
  const [currentChapter, setCurrentChapter] = useState(null);
  const [bookTitle, setBookTitle] = useState('');
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [ttsProgress, setTtsProgress] = useState(0);
  const [ttsStatus, setTtsStatus] = useState('');
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const audioRef = useRef(null);
  const socketRef = useRef(null);
  const wordTimingsRef = useRef([]);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState(null);
  const audioElementRef = useRef(new Audio());

  useEffect(() => {
    // Initialize socket connection
    const socket = io('http://localhost:5000', {
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      timeout: 10000
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to server');
      setIsConnected(true);
    });

    socket.on('disconnect', () => {
      console.log('Disconnected from server');
      setIsConnected(false);
      stopReading();
    });

    socket.on('connect_error', (error) => {
      console.error('Connection error:', error);
      setIsConnected(false);
    });

    socket.on('ttsError', (error) => {
      console.error('TTS Error:', error);
      setError(error);
      stopReading();
    });

    socket.on('audioChunk', (data) => {
      if (!isPlayingRef.current) return;
      
      // Convert base64 to blob
      const byteCharacters = atob(data.audioContent);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: data.type });
      
      audioQueueRef.current.push({
        blob,
        index: data.index,
        duration: data.duration
      });

      if (audioQueueRef.current.length === 1) {
        playNextChunk();
      }
    });

    socket.on('ttsComplete', () => {
      console.log('TTS conversion completed');
    });

    return () => {
      stopReading();
      socket.disconnect();
    };
  }, []);

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('http://localhost:5000/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      const data = await response.json();
      console.log('Upload response:', data);
      setChapters(data.chapters || []);
      setCurrentFileId(data.fileId);
      setBookTitle(data.title || file.name);
      // Don't set text here - wait for chapter selection
      setText('');
      setCurrentChapter(null);
    } catch (error) {
      console.error('Upload error:', error);
      alert('Error uploading file');
    } finally {
      setUploading(false);
    }
  };

  const loadChapter = async (chapter) => {
    if (!currentFileId) return;
    
    try {
      setIsLoading(true);
      setLoadingProgress(0);
      setText('');
      
      const response = await fetch(`http://localhost:5000/chapter/${currentFileId}/${chapter.id || `${chapter.startPage}-${chapter.endPage}`}`);
      if (!response.ok) {
        throw new Error('Failed to load chapter');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            
            switch (data.type) {
              case 'progress':
                setLoadingProgress(0);
                break;
              case 'chunk':
                accumulatedText += data.text + ' ';
                setText(accumulatedText);
                setLoadingProgress((data.progress / data.total) * 100);
                break;
              case 'complete':
                setLoadingProgress(100);
                break;
            }
          } catch (e) {
            console.error('Error parsing chunk:', e);
          }
        }
      }

      setCurrentChapter(chapter);
      setIsPlaying(false);
      setCurrentWord('');
    } catch (error) {
      console.error('Error loading chapter:', error);
      alert('Error loading chapter');
    } finally {
      setIsLoading(false);
    }
  };

  const startReading = async () => {
    if (!text || !socketRef.current) return;

    try {
      setError(null);
      setIsPlaying(true);
      isPlayingRef.current = true;
      setCurrentWord('');
      
      const audio = audioElementRef.current;
      audio.pause();
      audio.currentTime = 0;
      audio.src = '';
      audioQueueRef.current = [];

      socketRef.current.emit('convertToSpeech', { text });
    } catch (error) {
      console.error('Error starting reading:', error);
      setError('Failed to start reading');
      stopReading();
    }
  };

  const stopReading = () => {
    const audio = audioElementRef.current;
    audio.pause();
    audio.currentTime = 0;
    audio.src = '';
    audioQueueRef.current = [];
    setIsPlaying(false);
    isPlayingRef.current = false;
    setCurrentWord('');
  };

  const playNextChunk = () => {
    if (audioQueueRef.current.length === 0) {
      stopReading();
      return;
    }

    const nextChunk = audioQueueRef.current[0];
    const audioUrl = URL.createObjectURL(nextChunk.blob);
    const audio = audioElementRef.current;
    
    // Reset audio element
    audio.pause();
    audio.currentTime = 0;
    audio.src = audioUrl;

    // Calculate word timings for this chunk
    const allWords = text.split(/\s+/);
    const startIndex = nextChunk.index * 50;
    const endIndex = Math.min(startIndex + 50, allWords.length);
    const chunkWords = allWords.slice(startIndex, endIndex);

    // Calculate word durations based on word length and complexity
    const wordDurations = chunkWords.map(word => {
      let duration = word.length * 0.1;
      if (/[.,!?;:]/.test(word)) duration += 0.3;
      if (/\d/.test(word)) duration += 0.2;
      if (/[A-Z]/.test(word)) duration += 0.1;
      if (word.length > 8) duration += 0.2;
      return duration;
    });

    const totalDuration = wordDurations.reduce((sum, duration) => sum + duration, 0);
    const scaleFactor = nextChunk.duration / totalDuration;
    let currentTime = 0;

    wordTimingsRef.current = chunkWords.map((word, index) => {
      const duration = wordDurations[index] * scaleFactor;
      const startTime = currentTime;
      currentTime += duration;
      return {
        word,
        index: startIndex + index,
        startTime,
        endTime: currentTime
      };
    });

    wordTimingsRef.current.forEach((timing, index) => {
      if (index < wordTimingsRef.current.length - 1) {
        timing.endTime += 0.05;
      }
    });

    audio.addEventListener('timeupdate', () => {
      if (!isPlayingRef.current) return;
      
      const currentTime = audio.currentTime;
      const currentWordIndex = wordTimingsRef.current.findIndex(
        timing => currentTime >= timing.startTime && currentTime < timing.endTime
      );

      if (currentWordIndex !== -1) {
        const globalWordIndex = wordTimingsRef.current[currentWordIndex].index;
        setCurrentWord(globalWordIndex);
      }
    });

    audio.addEventListener('ended', () => {
      URL.revokeObjectURL(audioUrl);
      audioQueueRef.current.shift(); // Remove the played chunk
      
      if (audioQueueRef.current.length > 0 && isPlayingRef.current) {
        setTimeout(() => {
          if (isPlayingRef.current) {
            playNextChunk();
          }
        }, 200);
      } else {
        stopReading();
      }
    });

    audio.play().catch(error => {
      console.error('Error playing audio:', error);
      stopReading();
    });
  };

  const cleanup = async () => {
    if (currentFileId) {
      try {
        await fetch(`http://localhost:5000/cleanup/${currentFileId}`, {
          method: 'POST'
        });
      } catch (error) {
        console.error('Error cleaning up:', error);
      }
    }
  };

  // Cleanup when component unmounts
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [currentFileId]);

  // Add a function to render the text with highlighting
  const renderText = () => {
    if (!text) return null;

    const words = text.split(/\s+/);
    return (
      <div className="text-content">
        {words.map((word, index) => (
          <span
            key={index}
            className={`word ${index === currentWord ? 'highlighted' : ''}`}
            ref={el => {
              if (el && index === currentWord) {
                el.scrollIntoView({
                  behavior: 'smooth',
                  block: 'center'
                });
              }
            }}
          >
            {word}{' '}
          </span>
        ))}
      </div>
    );
  };

  return (
    <>
      <div>
        <a href="https://vite.dev" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>E-Book Reader with Text-to-Speech</h1>
      
      <div className="card">
        <input
          type="file"
          accept=".pdf,.epub"
          onChange={handleFileUpload}
          disabled={uploading}
          className="file-input"
        />
        {uploading && <p>Uploading...</p>}
      </div>

      {chapters && chapters.length > 0 && !text && (
        <div className="chapters-container">
          <h2>{bookTitle}</h2>
          <h3>Select a Chapter</h3>
          <div className="chapters-list">
            {chapters.map((chapter, index) => (
              <button
                key={index}
                onClick={() => loadChapter(chapter)}
                className="chapter-button"
                disabled={isLoading}
              >
                {chapter.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {isLoading && (
        <div className="loading-container">
          <div className="loading-progress">
            <div 
              className="loading-bar" 
              style={{ width: `${loadingProgress}%` }}
            />
          </div>
          <p>Loading chapter... {Math.round(loadingProgress)}%</p>
        </div>
      )}

      {text && (
        <div className="text-container">
          <div className="controls">
            <button 
              onClick={() => {
                setText('');
                setCurrentChapter(null);
                setCurrentWord('');
                setIsPlaying(false);
              }}
              className="control-button back-button"
            >
              Back to Chapters
            </button>
            <button 
              onClick={isPlaying ? stopReading : startReading}
              className="control-button"
              disabled={isGeneratingAudio}
            >
              {isPlaying ? 'Stop' : 'Start Reading'}
            </button>
          </div>

          {isGeneratingAudio && (
            <div className="loading-container">
              <div className="loading-progress">
                <div 
                  className="loading-bar" 
                  style={{ width: `${ttsProgress}%` }}
                />
              </div>
              <p>{ttsStatus} {Math.round(ttsProgress)}%</p>
            </div>
          )}
          
          {renderText()}
        </div>
      )}
    </>
  )
}

export default App
