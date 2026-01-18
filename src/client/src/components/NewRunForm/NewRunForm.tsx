import { useState } from 'react';
import type { FormEvent } from 'react';
import { useApp } from '../../context/AppContext';
import * as api from '../../api';
import './NewRunForm.css';

interface NewRunFormProps {
  onRunStarted: (runId: string) => void;
}

export function NewRunForm({ onRunStarted }: NewRunFormProps) {
  const { currentSessionId, currentSession, config, loadSessionRuns, loadRunDetail } = useApp();
  
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [validationModel, setValidationModel] = useState('');
  const [outputModel, setOutputModel] = useState('');
  const [validationPrompt, setValidationPrompt] = useState('');
  const [outputPrompt, setOutputPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!currentSessionId || !currentSession) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    
    if (!prompt.trim()) {
      alert('Please enter a prompt');
      return;
    }

    setLoading(true);

    try {
      const result = await api.createRun({
        sessionId: currentSessionId,
        prompt: prompt.trim(),
        validationPrompt: validationPrompt.trim() || undefined,
        outputPrompt: outputPrompt.trim() || undefined,
        model: model || undefined,
        validationModel: validationModel || undefined,
        outputModel: outputModel || undefined,
      });

      setPrompt('');
      setValidationPrompt('');
      setOutputPrompt('');
      
      loadSessionRuns(currentSessionId);
      loadRunDetail(result.runId);
      onRunStarted(result.runId);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to start run');
    } finally {
      setLoading(false);
    }
  };

  // Get session's effective models
  const workspace = config?.workspaces?.find(w => w.id === currentSession.workspaceId);
  const sessionModel = currentSession.defaultModel || workspace?.defaultModel || config?.defaultModel || '';
  const sessionValidationModel = currentSession.validationModel || workspace?.validationModel || config?.defaultValidationModel || sessionModel;
  const sessionOutputModel = currentSession.outputModel || workspace?.outputModel || config?.defaultOutputModel || sessionModel;

  return (
    <div className="new-run-form-container">
      <div className="view-header">
        <h2>New Run</h2>
      </div>
      
      <form className="run-form" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="runPrompt">Prompt</label>
          <textarea
            id="runPrompt"
            className="input textarea"
            rows={3}
            placeholder="What do you want to do next?"
            required
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>

        <div className="form-row">
          <div className="form-group">
            <label htmlFor="runModel">Model</label>
            <select 
              id="runModel"
              className="input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {config?.availableModels?.map(m => (
                <option key={m} value={m}>
                  {m === sessionModel ? `${m} (session default)` : m}
                </option>
              ))}
            </select>
          </div>
        </div>

        <details 
          className="advanced-options"
          open={showAdvanced}
          onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
        >
          <summary>Override Prompts</summary>
          
          <div className="form-section-header">Model Overrides</div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="runValidationModel">Validation Model</label>
              <select
                id="runValidationModel"
                className="input"
                value={validationModel}
                onChange={(e) => setValidationModel(e.target.value)}
              >
                {config?.availableModels?.map(m => (
                  <option key={m} value={m}>
                    {m === sessionValidationModel ? `${m} (session default)` : m}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="runOutputModel">Output Model</label>
              <select
                id="runOutputModel"
                className="input"
                value={outputModel}
                onChange={(e) => setOutputModel(e.target.value)}
              >
                {config?.availableModels?.map(m => (
                  <option key={m} value={m}>
                    {m === sessionOutputModel ? `${m} (session default)` : m}
                  </option>
                ))}
              </select>
            </div>
          </div>
          
          <div className="form-section-header">Prompt Overrides</div>
          <div className="form-group">
            <label htmlFor="runValidation">Validation Prompt</label>
            <textarea
              id="runValidation"
              className="input textarea"
              rows={2}
              placeholder="Override validation..."
              value={validationPrompt}
              onChange={(e) => setValidationPrompt(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="runOutput">Output Prompt</label>
            <textarea
              id="runOutput"
              className="input textarea"
              rows={2}
              placeholder="Override output generation..."
              value={outputPrompt}
              onChange={(e) => setOutputPrompt(e.target.value)}
            />
          </div>
        </details>

        <button 
          type="submit" 
          className={`btn btn-primary ${loading ? 'loading' : ''}`}
          disabled={loading}
        >
          <span className="btn-text">Start Run</span>
          {loading && <span className="btn-loading">Running...</span>}
        </button>
      </form>
    </div>
  );
}
