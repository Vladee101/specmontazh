// UC 02–03: пользователи (администратор).
import { useState } from 'react';
import { api, qs, type Page } from '../api';
import { useUser } from '../auth';
import { ROLE_LABELS, STATUS_LABELS, type Role, type TaskStatus } from '../labels';
import { Badge, ErrorBox, Field, Heading, Loading, Modal, Pager, Shell, Table, useFieldErrors, useFormState, useLoad, useToast } from '../ui';

interface UserRow {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  version: number;
  open_tasks_count: number;
}
interface UserDetail extends UserRow {
  open_tasks: { id: number; task_number: string; status: TaskStatus }[];
}
const PAGE_SIZE = 50;

export function Users() {
  const toast = useToast();
  const me = useUser();
  const [f, setF] = useState({ q: '', role: '' });
  const [page, setPage] = useState(1);
  const list = useLoad(() => api.get<Page<UserRow>>(`/users${qs({ ...f, page, page_size: PAGE_SIZE })}`), [f.q, f.role, page]);
  const [dialog, setDialog] = useState<null | { kind: 'new' } | { kind: 'edit' | 'block'; user: UserRow }>(null);
  const [error, setError] = useState<unknown>(null);
  const close = (message?: string) => {
    setDialog(null);
    if (message) toast(message);
    void list.reload();
  };

  return (
    <Shell section="Пользователи">
      <Heading
        title="Пользователи"
        sub="Учётные записи и доступ сотрудников"
        actions={
          <button className="sm-primary" onClick={() => setDialog({ kind: 'new' })}>
            + Добавить пользователя
          </button>
        }
      />
      <div className="sm-filters">
        <input aria-label="Поиск пользователя" placeholder="Поиск по имени или логину" onKeyDown={(e) => e.key === 'Enter' && (setF({ ...f, q: e.currentTarget.value.trim() }), setPage(1))} onBlur={(e) => setF({ ...f, q: e.currentTarget.value.trim() })} />
        <select aria-label="Роль" value={f.role} onChange={(e) => (setF({ ...f, role: e.target.value }), setPage(1))}>
          <option value="">Все роли</option>
          {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={list.error ?? error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : (
        <Table headers={['Сотрудник', 'Логин', 'Роль', 'Состояние', '']} footer={list.data && <Pager page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={setPage} />}>
          {list.data?.items.map((u) => (
            <tr key={u.id}>
              <td>
                <b>{u.full_name}</b>
                {u.role === 'engineer' && u.open_tasks_count > 0 && <small>Незавершённых заданий: {u.open_tasks_count}</small>}
              </td>
              <td>{u.login}</td>
              <td>{ROLE_LABELS[u.role]}</td>
              <td>{u.is_active ? <Badge color="green">Активен</Badge> : <Badge color="red">Заблокирован</Badge>}</td>
              <td>
                <button className="sm-link" onClick={() => setDialog({ kind: 'edit', user: u })}>
                  Изменить
                </button>
                {' · '}
                {u.is_active ? (
                  <button className="sm-link" onClick={() => setDialog({ kind: 'block', user: u })}>
                    Заблокировать
                  </button>
                ) : (
                  <button
                    className="sm-link"
                    onClick={async () => {
                      try {
                        setError(null);
                        await api.post(`/users/${u.id}/activate`);
                        close('Пользователь активирован; вход потребует нового входа в систему');
                      } catch (e) {
                        setError(e);
                      }
                    }}
                  >
                    Активировать
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <p className="sm-muted sm-small" style={{ marginTop: 16 }}>
        Блокировка завершает сессии пользователя; при повторной активации они не восстанавливаются. Задания заблокированного остаются за ним, руководитель
        переназначает их вручную.
      </p>

      {dialog?.kind === 'new' && <UserForm onClose={() => setDialog(null)} onSaved={() => close('Пользователь создан')} />}
      {dialog?.kind === 'edit' && <UserForm user={dialog.user} isSelf={dialog.user.id === me.id} onClose={() => setDialog(null)} onSaved={(m) => close(m)} />}
      {dialog?.kind === 'block' && <BlockDialog user={dialog.user} onClose={() => setDialog(null)} onDone={() => close('Пользователь заблокирован, сессии завершены')} />}
    </Shell>
  );
}

function UserForm({ user, isSelf, onClose, onSaved }: { user?: UserRow; isSelf?: boolean; onClose(): void; onSaved(message: string): void }) {
  const [v, set] = useFormState({ full_name: user?.full_name ?? '', login: user?.login ?? '', role: (user?.role ?? 'engineer') as Role, password: '' });
  const e = useFieldErrors();
  const roleLocked = user?.role === 'engineer' && user.open_tasks_count > 0;
  return (
    <Modal
      title={user ? `Пользователь: ${user.full_name}` : 'Новый пользователь'}
      onClose={onClose}
      onSubmit={() =>
        e.run(async () => {
          if (!user) {
            await api.post('/users', v);
            return onSaved('Пользователь создан');
          }
          const updated = await api.patch<UserRow>(`/users/${user.id}`, { version: user.version, full_name: v.full_name, login: v.login, role: v.role });
          if (v.password) {
            await api.post(`/users/${user.id}/password`, { version: updated.version, password: v.password });
            if (isSelf) return void window.location.reload(); // собственная сессия завершена
            return onSaved('Данные сохранены, пароль сброшен, сессии пользователя завершены');
          }
          onSaved('Данные пользователя сохранены');
        })
      }
    >
      <Field label="ФИО" error={e.of('full_name')}>
        <input value={v.full_name} onChange={(x) => set('full_name', x.target.value)} />
      </Field>
      <Field label="Логин (уникальный)" error={e.of('login')}>
        <input value={v.login} onChange={(x) => set('login', x.target.value)} autoComplete="off" />
      </Field>
      <Field label="Роль" error={e.of('role')}>
        <select value={v.role} disabled={roleLocked} onChange={(x) => set('role', x.target.value as Role)}>
          {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
      {roleLocked && <div className="sm-warning">Смена роли запрещена: у инженера {user.open_tasks_count} незавершённых назначений. Сначала передайте задания другому инженеру.</div>}
      {user?.role === 'admin' && <p className="sm-muted sm-small">Последнего активного администратора нельзя убрать или заблокировать.</p>}
      <Field label={user ? 'Новый пароль (сброс)' : 'Начальный пароль'} error={e.of('password')}>
        <input type="password" value={v.password} onChange={(x) => set('password', x.target.value)} autoComplete="new-password" placeholder={user ? 'Оставьте пустым, чтобы не менять' : 'Не короче 8 символов'} />
      </Field>
      {user && <p className="sm-muted sm-small">Сброс пароля завершает сессии пользователя.</p>}
    </Modal>
  );
}

function BlockDialog({ user, onClose, onDone }: { user: UserRow; onClose(): void; onDone(): void }) {
  const { data } = useLoad(() => api.get<UserDetail>(`/users/${user.id}`), [user.id]);
  return (
    <Modal
      title={`Заблокировать: ${user.full_name}`}
      submitLabel="Заблокировать"
      danger
      onClose={onClose}
      onSubmit={async () => {
        await api.post(`/users/${user.id}/block`);
        onDone();
      }}
    >
      {!data ? (
        <Loading />
      ) : data.open_tasks.length > 0 ? (
        <div className="sm-warning">
          Незавершённые задания ({data.open_tasks.length}): {data.open_tasks.map((t) => `${t.task_number} (${STATUS_LABELS[t.status]})`).join(', ')}. Блокировка разрешена, но
          руководителю придётся переназначить эти задания.
        </div>
      ) : (
        <p>Незавершённых заданий нет.</p>
      )}
      <p className="sm-muted sm-small" style={{ marginTop: 10 }}>
        Текущие сессии будут завершены. Историческое авторство результатов сохраняется.
      </p>
    </Modal>
  );
}
