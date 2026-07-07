import './LoginScreen.css'

export default function LoginScreen({ error }) {
  return (
    <div className="ls-root">
      <div className="ls-card">
        {/* Friendly outdoor scene — evokes the adventure-learning setting */}
        <div className="ls-scene" aria-hidden="true">
          <svg viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="ls-sky" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#ffe6c9" />
                <stop offset="0.55" stopColor="#ffd0b4" />
                <stop offset="1" stopColor="#dcecff" />
              </linearGradient>
            </defs>
            <rect width="400" height="150" fill="url(#ls-sky)" />
            <circle className="ls-sun-glow" cx="304" cy="54" r="40" fill="#ffd9a8" opacity="0.55" />
            <circle className="ls-sun" cx="304" cy="54" r="24" fill="#fb8b3c" />
            {/* rolling hills, back to front */}
            <path className="ls-hill ls-hill-3" d="M0 108 C 70 84 130 96 200 82 C 270 68 340 90 400 78 L400 150 L0 150 Z" fill="#7fe0cf" />
            <path className="ls-hill ls-hill-2" d="M0 124 C 80 104 150 116 224 102 C 300 88 352 108 400 100 L400 150 L0 150 Z" fill="#34b3a0" />
            <path className="ls-hill ls-hill-1" d="M0 140 C 90 124 168 134 244 126 C 320 118 360 132 400 128 L400 150 L0 150 Z" fill="#0f8a7e" />
          </svg>
        </div>

        <div className="ls-logo">V</div>

        <div className="ls-body">
          <h1 className="ls-title">Welcome to Vibe</h1>
          <p className="ls-sub">High 5 Adventure Learning Center</p>
          <p className="ls-hello">Good to see you — sign in to jump back in. 👋</p>

          {error && <div className="ls-error">{error}</div>}

          <a className="ls-google-btn" href="/api/google-auth">
            <svg className="ls-google-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </a>

          <p className="ls-note">🔒 Access is limited to authorized High 5 team members.</p>
        </div>
      </div>
    </div>
  )
}
