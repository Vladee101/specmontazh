// UC 01: вход. Неверные данные — общее сообщение.
import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ login: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form.login.trim() || !form.password) {
      setError('Введите логин и пароль');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(form.login.trim(), form.password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== '/login' ? from : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось войти');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sm-login">
      <div className="sm-login-hero">
        <div className="sm-brand">
          <span className="sm-monogram">СМ</span>
          <span>
            Спецмонтаж<small>Техническое обслуживание</small>
          </span>
        </div>
        <div>
          <h1>
            Все работы.
            <br />В нужный срок.
          </h1>
          <p>
            Объекты, регламенты и результаты
            <br />
            обслуживания в одном рабочем пространстве.
          </p>
        </div>
        <p style={{ fontSize: 11 }}>
          Пожарная сигнализация · СОУЭ
          <br />
          Охранная сигнализация · Видеонаблюдение
        </p>
      </div>
      <div className="sm-login-form">
        <form onSubmit={submit} noValidate>
          <h1>Вход в систему</h1>
          <p className="sm-muted">Введите данные вашей учётной записи</p>
          <label>
            Логин
            <input autoComplete="username" autoFocus value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value })} />
          </label>
          <label>
            Пароль
            <input type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
          {error && (
            <div className="sm-error" role="alert" style={{ marginTop: 18 }}>
              {error}
            </div>
          )}
          <button className="sm-primary" type="submit" disabled={busy}>
            {busy ? 'Вход…' : 'Войти →'}
          </button>
          <p className="sm-muted sm-small" style={{ marginTop: 22 }}>
            Если нет доступа, обратитесь к администратору организации.
          </p>
        </form>
      </div>
    </div>
  );
}
