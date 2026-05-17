import { Routes, Route } from 'react-router-dom';
import Disqualified from './screens/Disqualified';
import LanguageDisqualified from './screens/LanguageDisqualified';
import NotTamil from './screens/NotTamil';
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Disqualified />} />
      <Route path="/language" element={<LanguageDisqualified />} />
      <Route path="/not-tamil" element={<NotTamil />} />
    </Routes>
  );
}
