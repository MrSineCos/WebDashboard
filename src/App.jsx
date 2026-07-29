import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import RequireStation from './components/RequireStation.jsx';
import Login from './pages/Login.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Battery = lazy(() => import('./pages/Battery.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const DevConsole = lazy(() => import('./pages/DevConsole.jsx'));
const DevStations = lazy(() => import('./pages/DevStations.jsx'));

function App() {
  return (
    <Suspense fallback={null}>
      <Routes>
        <Route path="/" element={<ProtectedRoute><RequireStation><Dashboard /></RequireStation></ProtectedRoute>} />
        <Route path="/battery" element={<ProtectedRoute><RequireStation><Battery /></RequireStation></ProtectedRoute>} />
        <Route path="/reports" element={<ProtectedRoute><RequireStation><Reports /></RequireStation></ProtectedRoute>} />
        <Route path="/dev" element={<ProtectedRoute requireAdmin><RequireStation><DevConsole /></RequireStation></ProtectedRoute>} />
        <Route path="/dev/stations" element={<ProtectedRoute requireAdmin><RequireStation><DevStations /></RequireStation></ProtectedRoute>} />
        <Route path="/login" element={<Login />} />
      </Routes>
    </Suspense>
  );
}

export default App;
