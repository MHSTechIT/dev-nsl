import React from 'react';
import ReactDOM from 'react-dom/client';
import { LazyMotion, domAnimation } from 'framer-motion';
import './index.css';
import WhatsAppPage from './screens/WhatsAppPage';
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><LazyMotion features={domAnimation}><WhatsAppPage /></LazyMotion></React.StrictMode>);
