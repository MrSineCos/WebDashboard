import { Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import RequireStation from './components/RequireStation.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Battery from './pages/Battery.jsx';
import Reports from './pages/Reports.jsx';
import Login from './pages/Login.jsx';
import DevConsole from './pages/DevConsole.jsx';
import DevStations from './pages/DevStations.jsx';

function App() {
  return (
    <Routes>
      <Route path="/" element={<ProtectedRoute><RequireStation><Dashboard /></RequireStation></ProtectedRoute>} />
      <Route path="/battery" element={<ProtectedRoute><RequireStation><Battery /></RequireStation></ProtectedRoute>} />
      <Route path="/reports" element={<ProtectedRoute><RequireStation><Reports /></RequireStation></ProtectedRoute>} />
      <Route path="/dev" element={<ProtectedRoute requireAdmin><RequireStation><DevConsole /></RequireStation></ProtectedRoute>} />
      <Route path="/dev/stations" element={<ProtectedRoute requireAdmin><RequireStation><DevStations /></RequireStation></ProtectedRoute>} />
      <Route path="/login" element={<Login />} />
    </Routes>
  );
}

export default App;
