import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SettingsProvider } from './context/SettingsContext';
import BrowserPage from './pages/BrowserPage';
import Settings from './pages/Settings';

function App() {
  return (
    <SettingsProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<BrowserPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </SettingsProvider>
  );
}

export default App;
