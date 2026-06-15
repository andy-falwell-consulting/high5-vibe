import { useState, useCallback, useRef, useEffect } from 'react';
import { getAllRecords, getRecord, prefetchRecord } from '../api/filemaker';
import ColorLegend from './ColorLegend';
import './Contacts.css';

const LAYOUT = 'Contacts_New';

const STATUS_COLOR = {
  Active: '#22c55e',
  Inactive: '#64748b',
  Prospect: '#e87722',
  default: '#64748b',
};

export default function Contacts() {
  const [records, setRecords] = useState([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [navWidth, setNavWidth] = useState(280);
  const [tooltip, setTooltip] = useState(null);
  const isResizing = useRef(false);

  useEffect(() => {
    getAllRecords(LAYOUT, {
      onProgress: ({ records, total }) => { setRecords(records); setTotal(total); },
      batchSize: 100,
    });
  }, []);

  const filtered = records.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    const f = r.fieldData;
    return (
      f.zz__Display__ct?.toLowerCase().includes(q) ||
      f['cntct_ADDR::zz__Display_Single_Line__ct']?.toLowerCase().includes(q) ||
      f.Type?.toLowerCase().includes(q) ||
      f.Status?.toLowerCase().includes(q)
    );
  });

  async function handleSelect(r) {
    setSelected(r);
    setDetailLoading(true);
    const detail = await getRecord(LAYOUT, r.recordId);
    setSelected(detail.response.data[0]);
    setDetailLoading(false);
  }

  const startResize = useCallback((e) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const startX = e.clientX;
    const startW = navWidth;
    const onMove = (e) => {
      if (!isResizing.current) return;
      setNavWidth(Math.min(500, Math.max(180, startW + (e.clientX - startX))));
    };
    const onUp = () => {
      isResizing.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [navWidth]);

  const f = selected?.fieldData;
  const p = selected?.portalData;

  return (
    <div className="ct-container">
      {/* Sidebar */}
      <aside className="ct-sidebar" style={{ width: navWidth }}>
        <div className="ct-sidebar-header">
          <div className="ct-sidebar-title">
            <div className="ct-sidebar-logo">H5</div>
            <div>
              <div className="ct-sidebar-module">Contacts</div>
              <div className="ct-sidebar-count">{total ? `${total.toLocaleString()} contacts` : 'Loading…'}</div>
            </div>
          </div>
          <div className="ct-search-wrap" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <span className="ct-search-icon">⌕</span>
              <input
                className="ct-search"
                placeholder="Search…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <ColorLegend items={Object.entries(STATUS_COLOR).filter(([k]) => k !== 'default').map(([label, color]) => ({ label, color }))} />
          </div>
        </div>

        {records.length === 0 ? (
          <div className="ct-loading">
            {[...Array(8)].map((_, i) => <div key={i} className="ct-skeleton" />)}
          </div>
        ) : (
          <ul className="ct-list">
            {filtered.map(r => {
              const status = r.fieldData.Status;
              const color = STATUS_COLOR[status] || STATUS_COLOR.default;
              return (
                <li
                  key={r.recordId}
                  className={`ct-list-item ${selected?.recordId === r.recordId ? 'active' : ''}`}
                  onClick={() => handleSelect(r)}
                  onMouseEnter={e => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setTooltip({ r, x: rect.right + 8, y: rect.top });
                    prefetchRecord(LAYOUT, r.recordId);
                  }}
                  onMouseLeave={() => setTooltip(null)}
                >
                  <span className="ct-item-dot" style={{ background: color }} />
                  <div className="ct-item-text">
                    <div className="ct-item-name">{r.fieldData.zz__Display__ct || '—'}</div>
                    <div className="ct-item-sub">{r.fieldData['cntct_ADDR::zz__Display_Single_Line_No_Zip__ct'] || r.fieldData.Type || ''}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {/* Resize handle */}
      <div className="ct-resize-handle" onMouseDown={startResize} />

      {/* List item hover tooltip */}
      {tooltip && (
        <div className="ct-hover-tooltip" style={{ top: tooltip.y, left: tooltip.x }}>
          {tooltip.r.fieldData['Name_Organization'] && (
            <div className="ct-ht-row">
              <span className="ct-ht-label">Org</span>
              <span className="ct-ht-value">{tooltip.r.fieldData['Name_Organization']}</span>
            </div>
          )}
          {tooltip.r.fieldData['cntct_ADDR::Type'] && (
            <div className="ct-ht-row">
              <span className="ct-ht-label">Addr Type</span>
              <span className="ct-ht-value">{tooltip.r.fieldData['cntct_ADDR::Type']}</span>
            </div>
          )}
        </div>
      )}

      {/* Main */}
      <main className="ct-main">
        {!selected && !detailLoading && (
          <div className="ct-empty-state">
            <div className="ct-empty-icon">◈</div>
            <p>Select a contact</p>
          </div>
        )}

        {detailLoading && (
          <div className="ct-empty-state">
            <div className="ct-spinner-ring" />
          </div>
        )}

        {selected && !detailLoading && f && (
          <>
            {/* Top bar */}
            <div className="ct-topbar">
              <div className="ct-topbar-left">
                <div>
                  <h1 className="ct-title">{f.zz__Display__ct || '—'}</h1>
                  <div className="ct-meta-row">
                    {f.Type && <span className="ct-chip type">{f.Type}</span>}
                    {f.Status && (
                      <span className="ct-chip status" style={{
                        background: (STATUS_COLOR[f.Status] || '#64748b') + '22',
                        color: STATUS_COLOR[f.Status] || '#64748b',
                        borderColor: (STATUS_COLOR[f.Status] || '#64748b') + '44',
                      }}>{f.Status}</span>
                    )}
                    {f.Industry && <span className="ct-chip muted">{f.Industry}</span>}
                  </div>
                </div>
              </div>
            </div>

            <div className="ct-content">

              {/* Identity */}
              <Section title="Identity" icon="◈">
                <div className="ct-field-grid">
                  {f.Name_Organization && <Field label="Name / Organization" value={f.Name_Organization} />}
                  {f.Department && <Field label="Department" value={f.Department} />}
                  {f.Source && <Field label="Source" value={f.Source} />}
                  {f.Spouse && <Field label="Spouse" value={f.Spouse} />}
                  {f.Birthdate && <Field label="Birthdate" value={f.Birthdate} />}
                  {f['_kaf__qbo_id'] && <Field label="QuickBooks ID" value={f['_kaf__qbo_id']} mono />}
                </div>
              </Section>

              {/* Phone */}
              {p?.cntct_PHONE?.length > 0 && (
                <Section title="Phone" icon="✆">
                  <table className="ct-table">
                    <thead><tr><th>Number</th><th>Type</th></tr></thead>
                    <tbody>
                      {p.cntct_PHONE.map((row, i) => (
                        <tr key={i}>
                          <td className="mono">{row['cntct_PHONE::Number']}</td>
                          <td>{row['cntct_PHONE::Type']}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Email */}
              {p?.cntct_INADR?.length > 0 && (
                <Section title="Email" icon="✉">
                  <table className="ct-table">
                    <thead><tr><th>Address</th><th>Type</th></tr></thead>
                    <tbody>
                      {p.cntct_INADR.map((row, i) => (
                        <tr key={i}>
                          <td>{row['cntct_INADR::Address']}</td>
                          <td>{row['cntct_INADR::Type']}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Address */}
              {p?.cntct_ADDR?.length > 0 && (
                <Section title="Address" icon="◎">
                  <table className="ct-table">
                    <thead><tr><th>Street</th><th>City</th><th>State</th><th>Zip</th><th>Type</th></tr></thead>
                    <tbody>
                      {p.cntct_ADDR.map((row, i) => (
                        <tr key={i}>
                          <td>{row['cntct_ADDR::Street']}</td>
                          <td>{row['cntct_ADDR::City']}</td>
                          <td>{row['cntct_ADDR::State']}</td>
                          <td className="mono">{row['cntct_ADDR::Zip']}</td>
                          <td>{row['cntct_ADDR::Type']}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Related Contacts */}
              {p?.Portal__Contacts?.length > 0 && (
                <Section title="Related Contacts" icon="◉">
                  <table className="ct-table">
                    <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Relationship</th></tr></thead>
                    <tbody>
                      {p.Portal__Contacts.map((row, i) => (
                        <tr key={i}>
                          <td>{row['cntct_RLTN::zz__Display__ct']}</td>
                          <td className="mono">{row['cntct_rltn_cntct_PHONE::Number']}</td>
                          <td>{row['cntct_rltn_cntct_INADR__email::Address']}</td>
                          <td>{row['cntct_RLTN::zz__Display__ct']}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Estimates */}
              {p?.['Portal__Estimates 2']?.length > 0 && (
                <Section title="Estimates" icon="≡">
                  <table className="ct-table">
                    <thead><tr><th>ID</th><th>Date</th><th>Title</th><th className="num">Total</th><th>Status</th></tr></thead>
                    <tbody>
                      {p['Portal__Estimates 2'].map((row, i) => (
                        <tr key={i}>
                          <td className="mono">{row['cntct_ESTMT::_kpt__Estimate_ID']}</td>
                          <td>{row['cntct_ESTMT::Date']}</td>
                          <td>{row['cntct_ESTMT::Title']}</td>
                          <td className="num">${Number(row['cntct_ESTMT::zz__Total__xn'] || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                          <td>{row['cntct_ESTMT::Status']}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Invoices */}
              {p?.Portal__Invoices?.length > 0 && (
                <Section title="Invoices" icon="$">
                  <table className="ct-table">
                    <thead><tr><th>QB Ref</th><th>Date</th><th className="num">Total</th><th className="num">Balance</th><th>Memo</th></tr></thead>
                    <tbody>
                      {p.Portal__Invoices.map((row, i) => (
                        <tr key={i}>
                          <td className="mono">{row['cntct_INVO::QuickBooks_Reference_Number']}</td>
                          <td>{row['cntct_INVO::Date']}</td>
                          <td className="num">${Number(row['cntct_INVO::zz__Total__xn'] || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                          <td className="num" style={{ color: Number(row['cntct_INVO::zz__Balance_Due__xs']) > 0 ? '#e8322a' : 'inherit' }}>
                            ${Number(row['cntct_INVO::zz__Balance_Due__xs'] || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                          </td>
                          <td>{row['cntct_INVO::Memo']}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Section>
              )}

              {/* Notes */}
              {(f.Notes || f.Client_Alert || f.Keywords) && (
                <Section title="Notes" icon="✎">
                  <div className="ct-field-grid">
                    {f.Client_Alert && <Field label="Client Alert" value={f.Client_Alert} />}
                    {f.Keywords && <Field label="Keywords" value={f.Keywords} />}
                    {f.Notes && <Field label="Notes" value={f.Notes} wide />}
                  </div>
                </Section>
              )}

              {/* Record info */}
              <div className="ct-record-footer">
                ID {f._kpt__Contact_ID} · Created {f.zz__Created_On?.split(' ')[0]} by {f.zz__Created_By} · Modified {f.zz__Modified_On?.split(' ')[0]} by {f.zz__Modified_By}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Section({ title, icon, children }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="ct-section">
      <div className="ct-section-header" onClick={() => setCollapsed(c => !c)}>
        <span className="ct-section-icon">{icon}</span>
        <h3>{title}</h3>
        <span style={{ fontSize: 10, color: '#475569', marginLeft: 'auto', transition: 'transform 0.2s', display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
      </div>
      {!collapsed && children}
    </div>
  );
}

function Field({ label, value, mono, wide }) {
  return (
    <div className={`ct-field${wide ? ' wide' : ''}`}>
      <label>{label}</label>
      <div className={`ct-value${mono ? ' mono' : ''}`}>{value || '—'}</div>
    </div>
  );
}
