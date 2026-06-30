import { FMP_ENVIRONMENTS, getCurrentEnvId, setCurrentEnvId } from '../config/fmpEnvironments'

const ENV_THEME = {
  development: {
    dark:  { bg: '#052e16', border: '#14532d', badgeBg: '#14532d', badgeColor: '#86efac' },
    light: { bg: '#dcfce7', border: '#86efac', badgeBg: '#bbf7d0', badgeColor: '#166534' },
    label: null,
  },
  staging: {
    dark:  { bg: '#2d1f00', border: '#713f12', badgeBg: '#713f12', badgeColor: '#fde68a' },
    light: { bg: '#fef9c3', border: '#fde047', badgeBg: '#fef08a', badgeColor: '#854d0e' },
    label: null,
  },
  production: {
    dark:  { bg: '#3b0000', border: '#7f1d1d', badgeBg: '#7f1d1d', badgeColor: '#fca5a5' },
    light: { bg: '#fee2e2', border: '#fca5a5', badgeBg: '#fecaca', badgeColor: '#991b1b' },
    label: '⚠ Production',
  },
}

export default function EnvSwitcher({ theme, onToggleTheme }) {
  const currentId = getCurrentEnvId()
  const envTheme = (ENV_THEME[currentId] ?? ENV_THEME.development)[theme] ?? (ENV_THEME[currentId] ?? ENV_THEME.development).dark
  const isLight = theme === 'light'

  function handleChange(e) {
    setCurrentEnvId(e.target.value)
    window.location.reload()
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center',
      padding: '5px 12px',
      background: envTheme.bg,
      borderBottom: `1px solid ${envTheme.border}`,
      fontSize: 13,
    }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: isLight ? '#64748b' : '#64748b', fontWeight: 500 }}>FMP</span>
        <select
          value={currentId}
          onChange={handleChange}
          style={{
            fontSize: 13, padding: '2px 6px', borderRadius: 5,
            border: `1px solid ${isLight ? '#cbd5e1' : '#334155'}`,
            background: isLight ? '#ffffff' : '#1e293b',
            color: isLight ? '#1e293b' : '#e2e8f0',
            cursor: 'pointer',
          }}
        >
          {FMP_ENVIRONMENTS.map((env) => (
            <option key={env.id} value={env.id}>{env.label}</option>
          ))}
        </select>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '2px 7px',
          borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.06em',
          background: envTheme.badgeBg, color: envTheme.badgeColor,
        }}>
          {currentId}
        </span>
        {(ENV_THEME[currentId] ?? ENV_THEME.development).label && (
          <span style={{ color: envTheme.badgeColor, fontSize: 12, fontWeight: 600 }}>
            {(ENV_THEME[currentId] ?? ENV_THEME.development).label}
          </span>
        )}
      </div>
      <button
        onClick={onToggleTheme}
        title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: 15, padding: '2px 6px', marginRight: 8,
          opacity: 0.7, lineHeight: 1,
        }}
      >
        {isLight ? '🌙' : '☀️'}
      </button>
      <span style={{ fontSize: 11, fontWeight: 600, color: isLight ? '#475569' : '#475569', letterSpacing: '0.05em' }}>
        v{__APP_VERSION__}
      </span>
    </div>
  )
}
