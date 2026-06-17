import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import posthog from 'posthog-js'
import './index.css'
import App from './App.jsx'

Sentry.init({
  dsn: 'https://c3fc4a4fdfae43e90f7ed2abfd25d0db@o4511582143774720.ingest.us.sentry.io/4511582200135680',
  integrations: [Sentry.browserTracingIntegration()],
  tracesSampleRate: 0.2,
  environment: import.meta.env.MODE,
})

posthog.init('phc_pVWbzgzySDV7V5KiRHiT6nv9uzXWCXD3Vb8bXLbuvHxZ', {
  api_host: 'https://us.i.posthog.com',
  capture_pageview: true,
  capture_pageleave: true,
  autocapture: false,
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
