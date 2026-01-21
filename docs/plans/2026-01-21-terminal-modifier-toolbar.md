# Terminal Modifier Toolbar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a collapsible modifier key toolbar to the interactive terminal for mobile users who cannot easily type Shift+Tab and other modifier combinations.

**Architecture:** Add state management for modifier keys (Ctrl, Alt, Shift) and a collapsible toolbar UI to the InteractiveTerminal component. The toolbar shows a dedicated Shift+Tab button plus toggleable modifier buttons. When a modifier is active, the next key input combines with it.

**Tech Stack:** React, TypeScript, CSS

---

## Task 1: Add Modifier State Management

**Files:**
- Modify: `src/client/src/components/InteractiveTerminal/InteractiveTerminal.tsx:23-31`

**Step 1: Add state for toolbar visibility and active modifiers**

Add these state variables after the existing useState declarations (around line 30):

```typescript
const [showModifierToolbar, setShowModifierToolbar] = useState(false);
const [activeModifiers, setActiveModifiers] = useState<{
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}>({ ctrl: false, alt: false, shift: false });
```

**Step 2: Verify the component still compiles**

Run: `cd /home/jose/Desktop/ws/RemoteAgent/src/client && npm run build 2>&1 | head -30`
Expected: No errors related to the new state

---

## Task 2: Create Helper Function for Sending Key Sequences

**Files:**
- Modify: `src/client/src/components/InteractiveTerminal/InteractiveTerminal.tsx`

**Step 1: Add sendKeySequence function after the state declarations**

Add this function after the activeModifiers state (around line 35):

```typescript
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
```

**Step 2: Verify compilation**

Run: `cd /home/jose/Desktop/ws/RemoteAgent/src/client && npm run build 2>&1 | head -30`
Expected: No errors

---

## Task 3: Add Toolbar Toggle Button to Status Bar

**Files:**
- Modify: `src/client/src/components/InteractiveTerminal/InteractiveTerminal.tsx:351-366`

**Step 1: Add keyboard toggle button in the terminal-status div**

Replace the return statement JSX (lines 351-366) with:

```typescript
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
```

**Step 2: Verify compilation**

Run: `cd /home/jose/Desktop/ws/RemoteAgent/src/client && npm run build 2>&1 | head -30`
Expected: No errors (CSS warnings are OK at this stage)

---

## Task 4: Handle Modifier Keys with Terminal Input

**Files:**
- Modify: `src/client/src/components/InteractiveTerminal/InteractiveTerminal.tsx:218-227`

**Step 1: Modify the onData handler to apply active modifiers**

Replace the input handler (lines 218-227) with:

```typescript
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
```

**Step 2: Add activeModifiers and setActiveModifiers to the useCallback dependencies**

Update the connect useCallback dependency array (line 237) to include:

```typescript
}, [sessionId, onInteractionNeeded, onExit, bufferedWrite, flushWrites, activeModifiers]);
```

**Step 3: Verify compilation**

Run: `cd /home/jose/Desktop/ws/RemoteAgent/src/client && npm run build 2>&1 | head -30`
Expected: No errors

---

## Task 5: Add CSS Styles for Modifier Toolbar

**Files:**
- Modify: `src/client/src/components/InteractiveTerminal/InteractiveTerminal.css`

**Step 1: Add styles at the end of the CSS file**

```css
/* Modifier toolbar styles */
.modifier-toggle-btn {
  padding: 4px 8px;
  background: #45475a;
  color: #cdd6f4;
  border: none;
  border-radius: 4px;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.modifier-toggle-btn:hover {
  background: #585b70;
}

.modifier-toggle-btn.active {
  background: #89b4fa;
  color: #1e1e2e;
}

.modifier-toolbar {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  background: #181825;
  border-bottom: 1px solid #313244;
  flex-wrap: wrap;
}

.modifier-btn {
  padding: 6px 12px;
  background: #45475a;
  color: #cdd6f4;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  min-width: 44px;
  min-height: 36px;
}

.modifier-btn:hover {
  background: #585b70;
}

.modifier-btn.active {
  background: #89b4fa;
  color: #1e1e2e;
}

.modifier-btn.shift-tab-btn {
  background: #f5c2e7;
  color: #1e1e2e;
}

.modifier-btn.shift-tab-btn:hover {
  background: #f5c2e7;
  filter: brightness(1.1);
}

/* Mobile responsive for modifier toolbar */
@media (max-width: 768px) {
  .modifier-toolbar {
    padding: 6px 10px;
    gap: 6px;
  }

  .modifier-btn {
    padding: 8px 14px;
    font-size: 13px;
    min-height: 40px;
  }
}

@media (max-width: 480px) {
  .modifier-btn {
    flex: 1;
    min-width: 60px;
  }
}
```

**Step 2: Verify build completes**

Run: `cd /home/jose/Desktop/ws/RemoteAgent/src/client && npm run build 2>&1 | head -30`
Expected: Build successful

---

## Task 6: Test the Implementation

**Step 1: Start the development server**

Run: `cd /home/jose/Desktop/ws/RemoteAgent && npm run dev`

**Step 2: Manual testing checklist**

1. Open an interactive terminal session
2. Verify the ⌨️ button appears in the status bar when connected
3. Click ⌨️ - verify toolbar appears with: ⇧Tab, Ctrl, Alt, Esc buttons
4. Click ⇧Tab - verify it sends Shift+Tab to the terminal
5. Click Ctrl - verify it highlights, then type 'c' - verify Ctrl+C is sent
6. Click Alt - verify it highlights, then type a key - verify Alt+key is sent
7. Click Esc - verify escape is sent
8. Click ⌨️ again - verify toolbar hides
9. Test on mobile viewport (resize browser) - verify buttons are touch-friendly

---

## Task 7: Commit the Changes

**Step 1: Stage and commit**

```bash
git add src/client/src/components/InteractiveTerminal/InteractiveTerminal.tsx
git add src/client/src/components/InteractiveTerminal/InteractiveTerminal.css
git commit -m "feat(terminal): add modifier key toolbar for mobile users

Add a collapsible toolbar with:
- Dedicated Shift+Tab button (one tap)
- Ctrl/Alt modifier toggles that combine with next key
- Esc button for quick escape

Designed for mobile users who cannot easily type modifier key combinations."
```
