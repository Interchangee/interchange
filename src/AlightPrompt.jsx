export default function AlightPrompt({ inferredStop, onConfirm, onCorrect }) {
  if (!inferredStop) return null;
  return (
    <div className="prompt-overlay">
      <div className="prompt">
        <p>Cancellation detected.</p>
        <p>Based on your last GPS position, you alighted at:</p>
        <strong>{inferredStop.stop_name}</strong>
        <div className="prompt-actions">
          <button onClick={onConfirm}>That's right</button>
          <button onClick={onCorrect}>Different stop</button>
        </div>
      </div>
    </div>
  );
}