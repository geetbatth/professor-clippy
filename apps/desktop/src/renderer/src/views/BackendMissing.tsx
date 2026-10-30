import { Clippy } from '../clippy/Clippy';
import './BackendMissing.css';

/**
 * Shown when the renderer has no backend bridge (a broken preload in a real build).
 * Fits the mini window, which is the size the window starts at.
 */
export function BackendMissing() {
  return (
    <div className="missing" data-solid="" role="alert" title="Clippy can't reach the app's backend. Try restarting Professor Clippy.">
      <div className="missing-clippy">
        <Clippy mood="think" title="Professor Clippy, looking for his brain" />
      </div>
      <p className="missing-text">Clippy's brain fell out (backend unavailable)</p>
    </div>
  );
}
