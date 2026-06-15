import { FMP_ENVIRONMENTS, getCurrentEnvId, setCurrentEnvId } from '../config/fmpEnvironments'

const ENV_THEME = {
  development: {
    bg: '#052e16', border: '#14532d',
    badgeBg: '#14532d', badgeColor: '#86efac',
    label: null,
  },
  staging: {
    bg: '#2d1f00', border: '#713f12',
    badgeBg: '#713f12', badgeColor: '#fde68a',
    label: null,
  },
  production: {
    bg: '#3b0000', border: '#7f1d1d',
    badgeBg: '#7f1d1d', badgeColor: '#fca5a5',
    label: '⚠ Production',
  },
}

export default function EnvSwitcher() {
  const currentId = getCurrentEnvId()
  const theme = ENV_THEME[currentId] ?? ENV_THEME.development

  function handleChange(e) {
    setCurrentEnvId(e.target.value)
    window.location.reload()
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 12px',
      background: theme.bg,
      borderBottom: `1px solid ${theme.border}`,
      fontSize: 12,
    }}>
      <span style={{ color: '#64748b', fontWeight: 500 }}>FMP</span>
      <select
        value={currentId}
        onChange={handleChange}
        style={{
          fontSize: 12, padding: '2px 6px', borderRadius: 5,
          border: '1px solid #334155',
          background: '#1e293b', color: '#e2e8f0', cursor: 'pointer',
        }}
      >
        {FMP_ENVIRONMENTS.map((env) => (
          <option key={env.id} value={env.id}>{env.label}</option>
        ))}
      </select>
      <span style={{
        fontSize: 10, fontWeight: 700, padding: '2px 7px',
        borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.06em',
        background: theme.badgeBg, color: theme.badgeColor,
      }}>
        {currentId}
      </span>
      {theme.label && (
        <span style={{ color: theme.badgeColor, fontSize: 11, fontWeight: 600 }}>
          {theme.label}
        </span>
      )}
    </div>
  )
}
