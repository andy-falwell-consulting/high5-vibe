import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { registerServiceWorker } from './registerSW.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The app shell, cached, so an iPad in a field with no signal still opens.
// No-op in development and on localhost — see registerSW.js.
registerServiceWorker()
