import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import './InteractiveTerminal.css';

interface InteractiveTerminalProps {
  sessionId: string;
  isVisible?: boolean;
  onInteractionNeeded?: (reason: string) => void;
  onExit?: (exitCode: number) => void;
}

export function InteractiveTerminal({ sessionId, isVisible = true, onInteractionNeeded, onExit }: InteractiveTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastDimensionsRef = useRef<{ cols: number; rows: number } | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Modifier toolbar state (used by modifier key toolbar UI - will be implemented in subsequent tasks)
  const [showModifierToolbar, setShowModifierToolbar] = useState(false);
  // Use ref for activeModifiers to avoid re-renders and WebSocket reconnections
  // when modifier state changes during typing
  const activeModifiersRef = useRef<{
    ctrl: boolean;
    alt: boolean;
    shift: boolean;
  }>({ ctrl: false, alt: false, shift: false });
  // Separate state just for UI updates (modifier buttons highlighting)
  const [, setModifierUITrigger] = useState(0);

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
    activeModifiersRef.current = { ctrl: false, alt: false, shift: false };
    setModifierUITrigger(n => n + 1); // Trigger UI update for button highlighting
  }, [sessionId]);

  // Write buffer for batching rapid terminal output
  const writeBufferRef = useRef<string>('');
  const writeTimerRef = useRef<number | null>(null);

  // ACK-based flow control: track bytes received to send ACK to server
  const bytesReceivedRef = useRef(0);
  const ACK_THRESHOLD = 32768;  // Send ACK every 32KB

  // Constants for buffer management
  // CRITICAL: Must match or exceed server's OUTPUT_MAX_BUFFER_SIZE to prevent truncation
  const MAX_WRITE_BUFFER_SIZE = 131072; // 128KB max buffer (increased from 32KB to match server)
  const WRITE_CHUNK_SIZE = 8192; // 8KB chunks for smoother rendering

  // Flush buffered writes to terminal (batches rapid updates)
  const flushWrites = useCallback(() => {
    writeTimerRef.current = null;

    if (!writeBufferRef.current || !termRef.current) return;

    let dataToWrite = writeBufferRef.current;

    // If buffer is too large, truncate old data to prevent memory issues
    // With proper server-side flow control, this should NEVER trigger during normal operation
    if (dataToWrite.length > MAX_WRITE_BUFFER_SIZE) {
      const truncateAmount = dataToWrite.length - MAX_WRITE_BUFFER_SIZE;
      dataToWrite = dataToWrite.slice(truncateAmount);
      // PROMINENT WARNING: This indicates flow control issues
      console.warn(`[Terminal] ⚠️ DATA LOSS: Truncated ${truncateAmount} bytes from buffer! ` +
        `Buffer was ${truncateAmount + MAX_WRITE_BUFFER_SIZE} bytes, max is ${MAX_WRITE_BUFFER_SIZE}. ` +
        `This indicates server flow control may not be working correctly.`);
    }

    // Write in chunks to prevent browser freeze during large history loads
    if (dataToWrite.length > WRITE_CHUNK_SIZE) {
      const chunk = dataToWrite.slice(0, WRITE_CHUNK_SIZE);
      writeBufferRef.current = dataToWrite.slice(WRITE_CHUNK_SIZE);
      termRef.current.write(chunk);

      // Schedule next chunk with requestAnimationFrame for smoother rendering
      writeTimerRef.current = requestAnimationFrame(flushWrites);
    } else {
      writeBufferRef.current = '';
      termRef.current.write(dataToWrite);
    }
  }, []);

  // Buffered write - batches writes within 16ms (60fps)
  const bufferedWrite = useCallback((data: string) => {
    writeBufferRef.current += data;

    // CRITICAL: Enforce buffer limit during accumulation to prevent memory exhaustion
    // With proper server-side flow control, this should NEVER trigger during normal operation
    if (writeBufferRef.current.length > MAX_WRITE_BUFFER_SIZE) {
      const truncateAmount = writeBufferRef.current.length - MAX_WRITE_BUFFER_SIZE;
      writeBufferRef.current = writeBufferRef.current.slice(truncateAmount);
      // PROMINENT WARNING: This indicates flow control issues
      console.warn(`[Terminal] ⚠️ DATA LOSS in accumulation: Truncated ${truncateAmount} bytes! ` +
        `This indicates server flow control may not be working correctly.`);
    }

    if (!writeTimerRef.current) {
      writeTimerRef.current = window.setTimeout(flushWrites, 16);
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

    // 1. Start WebSocket connection IMMEDIATELY (network I/O runs in parallel)
    // This allows TCP handshake and WebSocket upgrade to happen while we initialize the terminal
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal/${sessionId}`);
    wsRef.current = ws;

    // 2. While WebSocket is connecting, initialize terminal (CPU work)
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

      // 3. Load WebGL addon (non-blocking, can fail gracefully)
      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          console.warn('[Terminal] WebGL context lost, disposing addon');
          webglAddon.dispose();
          webglAddonRef.current = null;
        });
        term.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
        console.log('[Terminal] WebGL renderer enabled');
      } catch (e) {
        console.warn('[Terminal] WebGL not supported, using default renderer:', e);
      }
    }

    const term = termRef.current;
    const fitAddon = fitAddonRef.current;

    // 4. Setup WebSocket handlers (ws may already be connected by now!)
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

          // ACK-based flow control: track bytes received and send ACK to server
          bytesReceivedRef.current += data.data.length;
          if (bytesReceivedRef.current >= ACK_THRESHOLD) {
            ws.send(JSON.stringify({
              type: 'pty-ack',
              sessionId,
              bytes: bytesReceivedRef.current,
            }));
            bytesReceivedRef.current = 0;
          }
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

    // 5. Handle terminal input - use wsRef.current to ensure we use the live WebSocket
    const inputDisposable = term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        let modifiedData = data;
        const modifiers = activeModifiersRef.current;

        // Apply Ctrl modifier (convert to control character)
        if (modifiers.ctrl && data.length === 1) {
          const charCode = data.charCodeAt(0);
          // Convert a-z or A-Z to control characters (Ctrl+A = 0x01, etc.)
          if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) {
            modifiedData = String.fromCharCode((charCode & 0x1f));
          }
          activeModifiersRef.current = { ctrl: false, alt: false, shift: false };
          // Note: No setModifierUITrigger here - avoid re-render on every keystroke
          // The modifier buttons will update on next render triggered by other state changes
        } else if (modifiers.alt) {
          // Apply Alt modifier (prepend ESC)
          modifiedData = '\x1b' + modifiedData;
          activeModifiersRef.current = { ctrl: false, alt: false, shift: false };
          // Note: No setModifierUITrigger here - avoid re-render on every keystroke
        }

        wsRef.current.send(JSON.stringify({
          type: 'pty-input',
          sessionId,
          data: modifiedData,
        }));
      }
    });

    return () => {
      inputDisposable.dispose();
      // Clear write buffer timer on cleanup (could be setTimeout or requestAnimationFrame)
      if (writeTimerRef.current) {
        cancelAnimationFrame(writeTimerRef.current);
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
    };
  }, [sessionId, onInteractionNeeded, onExit, bufferedWrite, flushWrites]);

  // Setup resize observer with debouncing and minimum size change threshold
  useEffect(() => {
    if (!terminalRef.current) return;

    const MIN_SIZE_CHANGE = 20; // Only refit if change > 20px
    let lastWidth = 0;
    let lastHeight = 0;
    let rafId: number | null = null;

    // Helper to perform fit and send resize
    const performResize = () => {
      rafId = null;
      if (!fitAddonRef.current || !termRef.current || !terminalRef.current) return;

      const width = terminalRef.current.offsetWidth;
      const height = terminalRef.current.offsetHeight;

      // Only proceed if significant size change
      if (Math.abs(width - lastWidth) < MIN_SIZE_CHANGE &&
          Math.abs(height - lastHeight) < MIN_SIZE_CHANGE) {
        return;
      }

      lastWidth = width;
      lastHeight = height;

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

    // Use requestAnimationFrame for resize debouncing
    const debouncedResize = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(performResize);
    };

    const resizeObserver = new ResizeObserver(debouncedResize);
    resizeObserver.observe(terminalRef.current);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
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
      // Clear any pending write buffer timer (could be setTimeout or requestAnimationFrame)
      if (writeTimerRef.current) {
        cancelAnimationFrame(writeTimerRef.current);
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      // Clear the write buffer to free memory
      writeBufferRef.current = '';
      // Dispose WebGL addon before terminal (must be disposed first)
      if (webglAddonRef.current) {
        try {
          webglAddonRef.current.dispose();
        } catch (e) {
          console.warn('[Terminal] Error disposing WebGL addon:', e);
        }
        webglAddonRef.current = null;
      }
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
            className={`modifier-btn ${activeModifiersRef.current.ctrl ? 'active' : ''}`}
            onClick={() => {
              activeModifiersRef.current = { ...activeModifiersRef.current, ctrl: !activeModifiersRef.current.ctrl };
              setModifierUITrigger(n => n + 1);
            }}
            title="Ctrl modifier"
          >
            Ctrl
          </button>
          <button
            className={`modifier-btn ${activeModifiersRef.current.alt ? 'active' : ''}`}
            onClick={() => {
              activeModifiersRef.current = { ...activeModifiersRef.current, alt: !activeModifiersRef.current.alt };
              setModifierUITrigger(n => n + 1);
            }}
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
