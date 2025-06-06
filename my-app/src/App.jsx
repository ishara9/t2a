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

  useEffect(() => {
    // Connect to Socket.IO server
    socketRef.current = io('http://localhost:5000');

    socketRef.current.on('connect', () => {
      console.log('Connected to server');
    });

    socketRef.current.on('ttsProgress', (data) => {
      setTtsProgress(data.progress);
      setTtsStatus(data.status);
    });

    socketRef.current.on('audioChunk', (data) => {
      // Convert base64 to blob
      const byteCharacters = atob(data.chunk);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: data.type });
      
      // Add to audio queue
      audioQueueRef.current.push({
        blob,
        index: data.index,
        duration: data.duration,
        wordCount: data.wordCount
      });

      // If this is the first chunk and we're ready to play, start playing
      if (data.index === 0 && isPlayingRef.current) {
        playNextChunk();
      }
    });

    socketRef.current.on('ttsComplete', () => {
      setIsGeneratingAudio(false);
      // Only start playing if we haven't started yet and have chunks
      if (isPlayingRef.current && audioQueueRef.current.length > 0 && !audioRef.current) {
        playNextChunk();
      }
    });

    socketRef.current.on('ttsError', (error) => {
      console.error('TTS error:', error);
      setIsPlaying(false);
      setIsGeneratingAudio(false);
      isPlayingRef.current = false;
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      if (audioRef.current) {
        audioRef.current.pause();
      }
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

  const startReading = () => {
    if (!text) return;
    
    // Reset states
    setIsPlaying(true);
    isPlayingRef.current = true;
    setCurrentWord('');
    setIsGeneratingAudio(true);
    setTtsProgress(0);
    setTtsStatus('Starting...');
    audioQueueRef.current = []; // Clear any existing queue
    
    // Stop any existing audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    // Request text-to-speech conversion
    socketRef.current.emit('convertToSpeech', { text });
  };

  const stopReading = () => {
    setIsPlaying(false);
    isPlayingRef.current = false;
    setCurrentWord('');
    setIsGeneratingAudio(false);
    
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    
    // Clear the audio queue
    audioQueueRef.current = [];
  };

  const playNextChunk = () => {
    if (audioQueueRef.current.length === 0) {
      setIsPlaying(false);
      isPlayingRef.current = false;
      setCurrentWord('');
      return;
    }

    const nextChunk = audioQueueRef.current.shift();
    const audioUrl = URL.createObjectURL(nextChunk.blob);
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    // Calculate word timings for this chunk
    const chunkWords = text.split(/\s+/).slice(
      nextChunk.index * 50,
      (nextChunk.index + 1) * 50
    );

    const wordScores = chunkWords.map(word => {
      let score = word.length;
      if (/[.,!?;:]/.test(word)) score += 2;
      if (/\d/.test(word)) score += 1;
      if (/[A-Z]/.test(word)) score += 1;
      return score;
    });

    const totalScore = wordScores.reduce((sum, score) => sum + score, 0);
    let currentTime = 0;

    wordTimingsRef.current = chunkWords.map((word, index) => {
      const wordDuration = (wordScores[index] / totalScore) * nextChunk.duration;
      const startTime = currentTime;
      currentTime += wordDuration;
      return {
        word,
        index: nextChunk.index * 50 + index,
        startTime,
        endTime: currentTime
      };
    });

    audio.addEventListener('timeupdate', () => {
      if (!isPlayingRef.current) return;
      
      const currentTime = audio.currentTime;
      const currentWordIndex = wordTimingsRef.current.findIndex(
        timing => currentTime >= timing.startTime && currentTime < timing.endTime
      );

      if (currentWordIndex !== -1) {
        const globalWordIndex = nextChunk.index * 50 + currentWordIndex;
        setCurrentWord(globalWordIndex);
      }
    });

    audio.onended = () => {
      URL.revokeObjectURL(audioUrl);
      if (audioQueueRef.current.length > 0 && isPlayingRef.current) {
        playNextChunk();
      } else {
        setIsPlaying(false);
        isPlayingRef.current = false;
        setCurrentWord('');
      }
    };

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
          
          <div className="text-display">
            {text.split(/\s+/).map((word, index) => (
              <span
                key={index}
                className={`word ${index === currentWord ? 'highlight' : ''}`}
              >
                {word}{' '}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

export default App
