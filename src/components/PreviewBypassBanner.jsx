import './PreviewBypassBanner.css'

// Shown on the preview deployment whenever the current session came from the
// shared fallback identity (see api/_googleSession.js) rather than a real
// login — i.e. this visitor never signed in. Actions taken here are
// attributed to whoever last captured the fallback session (Admin → Preview
// access), so this stays visible the whole time to make that unambiguous.
export default function PreviewBypassBanner() {
  return (
    <div className="pvb-bar">
      <span className="pvb-icon">🔓</span>
      <span className="pvb-text">
        <strong>Preview — no login required.</strong> Actions here run as whoever set up this preview link.
      </span>
      <a className="pvb-signin" href="/api/google-auth">Sign in as yourself →</a>
    </div>
  )
}
