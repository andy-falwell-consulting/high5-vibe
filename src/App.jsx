import { useState } from 'react';
import ProductsAndServices from './components/ProductsAndServices';
import ProductsAndServicesV2 from './components/ProductsAndServicesV2';
import EnvSwitcher from './components/EnvSwitcher';

export default function App() {
  const [version, setVersion] = useState('v2');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <EnvSwitcher />
      {/* Version toggle */}
      <div style={{
        position: 'fixed', bottom: 16, right: 16, zIndex: 9999,
        display: 'flex', gap: 4,
        background: '#13151c', border: '1px solid #2a2f45',
        borderRadius: 10, padding: 4,
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)'
      }}>
        {['v1', 'v2'].map(v => (
          <button key={v} onClick={() => setVersion(v)} style={{
            padding: '5px 14px', borderRadius: 7, border: 'none',
            fontSize: 12, fontWeight: 600, cursor: 'pointer',
            background: version === v ? '#6366f1' : 'transparent',
            color: version === v ? '#fff' : '#475569',
            transition: 'all 0.15s',
          }}>{v.toUpperCase()}</button>
        ))}
      </div>
      {version === 'v1' ? <ProductsAndServices /> : <ProductsAndServicesV2 />}
    </div>
  );
}
