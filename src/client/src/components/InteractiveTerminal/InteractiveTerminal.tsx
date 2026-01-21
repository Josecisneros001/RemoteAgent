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
  // Modifier toolbar state (used by modifier key toolbar UI - will be implemented in subsequent tasks)
  const [showModifierToolbar, setShowModifierToolbar] = useState(false);
  const [activeModifiers, setActiveModifiers] = useState<{
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
  }>({ ctrl: false, alt: false, shift: false });

  // Send a key sequence to the terminal via WebSocket
  const sendKeySequence = useCallback((sequence: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'pty-input',
        sessionId,
        data: sequence,
      }));
    }
    // Clear modifiers after sending
    setActiveModifiers({ ctrl: false, alt: false, shift: false });
  }, [sessionId]);

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

    // CRITICAL: Enforce buffer limit during accumulation to prevent memory exhaustion
    if (writeBufferRef.current.length > MAX_WRITE_BUFFER_SIZE) {
      const truncateAmount = writeBufferRef.current.length - MAX_WRITE_BUFFER_SIZE;
      writeBufferRef.current = writeBufferRef.current.slice(truncateAmount);
    }

    if (!writeTimerRef.current) {
      writeTimerRef.current = setTimeout(flushWrites, 16);
    }
  }, [flushWrites]);

  // Refit terminal when visibility changes (debounced to prevent excessive calls)
  const lastRefitRef = useRef<number>(0);
  const refitTerminal = useCallback(() => {
    if (!fitAddonRef.current || !termRef.current) return;

    // Debounce: don't refit more than once per 100ms
    const now = Date.now();
    if (now - lastRefitRef.current < 100) return;
    lastRefitRef.current = now;

    try {
      fitAddonRef.current.fit();
      // Only refresh visible rows, not full terminal
      termRef.current.scrollToBottom();
    } catch (e) {
      console.error('[Terminal] Refit error:', e);
    }
  }, []);

  useEffect(() => {
    if (isVisible) {
      // Small delay to ensure container has correct dimensions
      setTimeout(refitTerminal, 50);
    }
  }, [isVisible, refitTerminal]);

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
        let modifiedData = data;

        // Apply Ctrl modifier (convert to control character)
        if (activeModifiers.ctrl && data.length === 1) {
          const charCode = data.charCodeAt(0);
          // Convert a-z or A-Z to control characters (Ctrl+A = 0x01, etc.)
          if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) {
            modifiedData = String.fromCharCode((charCode & 0x1f));
          }
          setActiveModifiers({ ctrl: false, alt: false, shift: false });
        }

        // Apply Alt modifier (prepend ESC)
        if (activeModifiers.alt) {
          modifiedData = '\x1b' + modifiedData;
          setActiveModifiers({ ctrl: false, alt: false, shift: false });
        }

        ws.send(JSON.stringify({
          type: 'pty-input',
          sessionId,
          data: modifiedData,
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
  }, [sessionId, onInteractionNeeded, onExit, bufferedWrite, flushWrites, activeModifiers]);

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

  // Consolidated visibility handling - handles both document visibility and intersection
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setTimeout(refitTerminal, 50);
      }
    };

    // IntersectionObserver for when terminal becomes visible in DOM
    const intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          setTimeout(refitTerminal, 50);
        }
      });
    }, { threshold: 0.1 }); // Only trigger when at least 10% visible

    if (terminalRef.current) {
      intersectionObserver.observe(terminalRef.current);
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      intersectionObserver.disconnect();
    };
  }, [refitTerminal]);

  // Cleanup terminal on unmount
  useEffect(() => {
    return () => {
      // Clear any pending write buffer timer
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      // Clear the write buffer to free memory
      writeBufferRef.current = '';
      // Dispose the terminal
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
        {isConnected && (
          <button
            className={`modifier-toggle-btn ${showModifierToolbar ? 'active' : ''}`}
            onClick={() => setShowModifierToolbar(!showModifierToolbar)}
            title="Toggle modifier keys toolbar"
          >
            ⌨️
          </button>
        )}
      </div>
      {showModifierToolbar && isConnected && (
        <div className="modifier-toolbar">
          <button
            className="modifier-btn shift-tab-btn"
            onClick={() => sendKeySequence('\x1b[Z')}
            title="Shift+Tab"
          >
            ⇧Tab
          </button>
          <button
            className={`modifier-btn ${activeModifiers.ctrl ? 'active' : ''}`}
            onClick={() => setActiveModifiers(prev => ({ ...prev, ctrl: !prev.ctrl }))}
            title="Ctrl modifier"
          >
            Ctrl
          </button>
          <button
            className={`modifier-btn ${activeModifiers.alt ? 'active' : ''}`}
            onClick={() => setActiveModifiers(prev => ({ ...prev, alt: !prev.alt }))}
            title="Alt modifier"
          >
            Alt
          </button>
          <button
            className="modifier-btn"
            onClick={() => sendKeySequence('\x1b')}
            title="Escape"
          >
            Esc
          </button>
        </div>
      )}
      <div ref={terminalRef} className="terminal-wrapper" />
    </div>
  );
}
