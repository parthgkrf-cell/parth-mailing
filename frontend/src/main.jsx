import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { CampaignProvider } from './context/CampaignContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <CampaignProvider>
        <App />
      </CampaignProvider>
    </AuthProvider>
  </StrictMode>,
)
