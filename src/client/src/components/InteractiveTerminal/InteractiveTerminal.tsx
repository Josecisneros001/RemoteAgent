import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './InteractiveTerminal.css';

interface InteractiveTerminalProps {
  sessionId: string;
  isVisible?: boolean;
  onInteractionNeeded?: (reason: string) => void;
  onExit?: (exitCode: number) => void;
}

// Debounce utility
function debounce<T extends (...args: unknown[]) => void>(fn: T, delay: number): T {
  let timeoutId: ReturnType<typeof setTimeout>;
  return ((...args: unknown[]) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  }) as T;
}

export function InteractiveTerminal({ sessionId, isVisible = true, onInteractionNeeded, onExit }: InteractiveTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Write buffer for batching rapid terminal output
  const writeBufferRef = useRef<string>('');
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Constants for buffer management
  const MAX_WRITE_BUFFER_SIZE = 32768; // 32KB max buffer to prevent memory issues
  const WRITE_CHUNK_SIZE = 8192; // 8KB chunks for smoother rendering

  // Flush buffered writes to terminal (batches rapid updates)
  const flushWrites = useCallback(() => {
    writeTimerRef.current = null;

    if (!writeBufferRef.current || !termRef.current) return;

    let dataToWrite = writeBufferRef.current;

    // If buffer is too large, truncate old data to prevent memory issues
    if (dataToWrite.length > MAX_WRITE_BUFFER_SIZE) {
      const truncateAmount = dataToWrite.length - MAX_WRITE_BUFFER_SIZE;
      dataToWrite = dataToWrite.slice(truncateAmount);
      console.log(`[Terminal] Truncated ${truncateAmount} bytes from buffer`);
    }

    // Write in chunks to prevent browser freeze during large history loads
    if (dataToWrite.length > WRITE_CHUNK_SIZE) {
      const chunk = dataToWrite.slice(0, WRITE_CHUNK_SIZE);
      writeBufferRef.current = dataToWrite.slice(WRITE_CHUNK_SIZE);
      termRef.current.write(chunk);

      // Schedule next chunk with requestAnimationFrame for smoother rendering
      writeTimerRef.current = setTimeout(flushWrites, 8);
    } else {
      writeBufferRef.current = '';
      termRef.current.write(dataToWrite);
    }
  }, []);

  // Buffered write - batches writes within 16ms (60fps)
  const bufferedWrite = useCallback((data: string) => {
    writeBufferRef.current += data;
    if (!writeTimerRef.current) {
      writeTimerRef.current = setTimeout(flushWrites, 16);
    }
  }, [flushWrites]);

  // Refit terminal when visibility changes
  useEffect(() => {
    if (isVisible && fitAddonRef.current && termRef.current) {
      // Small delay to ensure container has correct dimensions
      setTimeout(() => {
        try {
          fitAddonRef.current?.fit();
          termRef.current?.refresh(0, termRef.current.rows - 1);
        } catch (e) {
          console.error('[Terminal] Refit on visibility error:', e);
        }
      }, 50);
    }
  }, [isVisible]);

  // Connect WebSocket and setup terminal
  const connect = useCallback(() => {
    if (!terminalRef.current || wsRef.current?.readyState === WebSocket.OPEN) return;

    // Create terminal if not exists
    if (!termRef.current) {
      const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Monaco, "Courier New", monospace',
        theme: {
          background: '#1e1e2e',
          foreground: '#cdd6f4',
          cursor: '#f5e0dc',
          cursorAccent: '#1e1e2e',
          selectionBackground: '#585b70',
          black: '#45475a',
          red: '#f38ba8',
          green: '#a6e3a1',
          yellow: '#f9e2af',
          blue: '#89b4fa',
          magenta: '#f5c2e7',
          cyan: '#94e2d5',
          white: '#bac2de',
          brightBlack: '#585b70',
          brightRed: '#f38ba8',
          brightGreen: '#a6e3a1',
          brightYellow: '#f9e2af',
          brightBlue: '#89b4fa',
          brightMagenta: '#f5c2e7',
          brightCyan: '#94e2d5',
          brightWhite: '#a6adc8',
        },
        allowProposedApi: true,
        scrollback: 2000, // Reduced from 10000 to prevent memory issues with large sessions
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      
      term.open(terminalRef.current);
      fitAddon.fit();
      
      termRef.current = term;
      fitAddonRef.current = fitAddon;
    }

    const term = termRef.current;
    const fitAddon = fitAddonRef.current;

    // Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal/${sessionId}`);
    
    ws.onopen = () => {
      console.log('[Terminal] WebSocket connected');
      setIsConnected(true);
      setError(null);
      
      // Send initial resize
      if (fitAddon && term) {
        ws.send(JSON.stringify({
          type: 'pty-resize',
          sessionId,
          cols: term.cols,
          rows: term.rows,
        }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'pty-data') {
          // Use buffered write to prevent overwhelming the browser with rapid updates
          bufferedWrite(data.data);
        } else if (data.type === 'interaction-needed') {
          onInteractionNeeded?.(data.reason);
        } else if (data.type === 'pty-exit') {
          onExit?.(data.exitCode);
          // Flush any pending writes before showing exit message
          flushWrites();
          termRef.current?.write(`\r\n\x1b[90m--- Session ended (exit code: ${data.exitCode}) ---\x1b[0m\r\n`);
        }
      } catch (e) {
        console.error('[Terminal] Error parsing message:', e);
      }
    };

    ws.onerror = (event) => {
      console.error('[Terminal] WebSocket error:', event);
      setError('Connection error');
    };

    ws.onclose = (event) => {
      console.log('[Terminal] WebSocket closed:', event.code, event.reason);
      setIsConnected(false);
      
      if (event.code === 4000) {
        setError('No active session. Click Resume to start.');
      } else if (event.code !== 1000) {
        setError(`Connection closed: ${event.reason || 'Unknown reason'}`);
      }
    };

    wsRef.current = ws;

    // Handle terminal input
    const inputDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'pty-input',
          sessionId,
          data,
        }));
      }
    });

    return () => {
      inputDisposable.dispose();
      // Clear write buffer timer on cleanup
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
    };
  }, [sessionId, onInteractionNeeded, onExit, bufferedWrite, flushWrites]);

  // Setup resize observer with debouncing
  useEffect(() => {
    if (!terminalRef.current) return;

    // Helper to perform fit and send resize
    const performResize = () => {
      if (!fitAddonRef.current || !termRef.current) return;
      
      try {
        fitAddonRef.current.fit();
      } catch (e) {
        console.error('[Terminal] Fit error:', e);
        return;
      }
      
      const { cols, rows } = termRef.current;
      
      // Sanity check - don't send absurd dimensions
      if (rows > 500 || cols > 500 || rows < 1 || cols < 1) {
        console.warn(`[Terminal] Ignoring invalid dimensions: ${cols}x${rows}`);
        return;
      }
      
      // Only send if dimensions actually changed
      const last = lastDimensionsRef.current;
      if (last && last.cols === cols && last.rows === rows) {
        return;
      }
      lastDimensionsRef.current = { cols, rows };
      
      // Send resize to server
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'pty-resize',
          sessionId,
          cols,
          rows,
        }));
      }
    };

    // Debounce resize events
    const debouncedResize = debounce(performResize, 100);

    const resizeObserver = new ResizeObserver(() => {
      debouncedResize();
    });

    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, [sessionId]);

  // Connect on mount
  useEffect(() => {
    const cleanup = connect();
    
    return () => {
      cleanup?.();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  // Handle visibility change (tab switching) - refit terminal when visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && fitAddonRef.current && termRef.current) {
        // Small delay to ensure container has correct dimensions
        setTimeout(() => {
          try {
            fitAddonRef.current?.fit();
            termRef.current?.refresh(0, termRef.current.rows - 1);
          } catch (e) {
            console.error('[Terminal] Refit on visibility error:', e);
          }
        }, 50);
      }
    };

    // Also handle when terminal container becomes visible in DOM
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && fitAddonRef.current && termRef.current) {
          setTimeout(() => {
            try {
              fitAddonRef.current?.fit();
              termRef.current?.refresh(0, termRef.current.rows - 1);
            } catch (e) {
              console.error('[Terminal] Refit on intersection error:', e);
            }
          }, 50);
        }
      });
    });

    if (terminalRef.current) {
      observer.observe(terminalRef.current);
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      observer.disconnect();
    };
  }, []);

  // Cleanup terminal on unmount
  useEffect(() => {
    return () => {
      termRef.current?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  return (
    <div className="interactive-terminal-container">
      <div className="terminal-status">
        <span className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`} />
        <span className="status-text">
          {isConnected ? 'Connected' : error || 'Disconnected'}
        </span>
        {!isConnected && !error && (
          <button className="reconnect-btn" onClick={connect}>
            Reconnect
          </button>
        )}
      </div>
      <div ref={terminalRef} className="terminal-wrapper" />
    </div>
  );
}
