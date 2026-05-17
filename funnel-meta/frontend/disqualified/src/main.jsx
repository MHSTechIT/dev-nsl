import React from 'react';
import ReactDOM from 'react-dom/client';
import { LazyMotion, domAnimation } from 'framer-motion';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App';
ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><LazyMotion features={domAnimation}><BrowserRouter><App /></BrowserRouter></LazyMotion></React.StrictMode>);
