import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import type { Role } from './labels';
import { Checklist } from './pages/Checklist';
import { Login } from './pages/Login';
import { MyTasks } from './pages/MyTasks';
import { ObjectCard } from './pages/ObjectCard';
import { Objects } from './pages/Objects';
import { Regulations } from './pages/Regulations';
import { Report } from './pages/Report';
import { TaskCard } from './pages/TaskCard';
import { Tasks } from './pages/Tasks';
import { Templates } from './pages/Templates';
import { Users } from './pages/Users';
import { Loading, Shell } from './ui';

const HOME: Record<Role, string> = { admin: '/users', manager: '/tasks', engineer: '/my-tasks' };

function Guard({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  if (!roles.includes(user.role)) return <Navigate to={HOME[user.role]} replace />;
  return <>{children}</>;
}

function NotFound() {
  return (
    <Shell section="Нет страницы">
      <h1>Страница не найдена</h1>
      <p className="sm-muted">Проверьте адрес или вернитесь в рабочий раздел через меню.</p>
    </Shell>
  );
}

export function App() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) {
    return location.pathname === '/login' ? <Login /> : <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  const manager: Role[] = ['manager'];
  return (
    <Routes>
      <Route path="/" element={<Navigate to={HOME[user.role]} replace />} />
      <Route path="/login" element={<Navigate to={HOME[user.role]} replace />} />
      <Route path="/users" element={<Guard roles={['admin']}><Users /></Guard>} />
      <Route path="/tasks" element={<Guard roles={manager}><Tasks /></Guard>} />
      <Route path="/tasks/:id" element={<Guard roles={['manager', 'engineer']}>{user.role === 'engineer' ? <Checklist /> : <TaskCard />}</Guard>} />
      <Route path="/objects" element={<Guard roles={manager}><Objects /></Guard>} />
      <Route path="/objects/:id" element={<Guard roles={manager}><ObjectCard /></Guard>} />
      <Route path="/regulations" element={<Guard roles={manager}><Regulations /></Guard>} />
      <Route path="/templates" element={<Guard roles={manager}><Templates /></Guard>} />
      <Route path="/report" element={<Guard roles={manager}><Report /></Guard>} />
      <Route path="/my-tasks" element={<Guard roles={['engineer']}><MyTasks /></Guard>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
