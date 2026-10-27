// UC 04: объекты обслуживания — список и создание.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs, type Page } from '../api';
import { count } from '../format';
import type { ServiceObject } from '../types';
import { Badge, ErrorBox, Heading, Loading, Pager, Shell, Table, useLoad } from '../ui';
import { ObjectDialog } from './catalogDialogs';

const PAGE_SIZE = 25;

export function Objects() {
  const navigate = useNavigate();
  const [archived, setArchived] = useState(false);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data, error, loading } = useLoad(() => api.get<Page<ServiceObject>>(`/objects${qs({ q, archived, page, page_size: PAGE_SIZE })}`), [q, archived, page]);

  return (
    <Shell section="Объекты">
      <Heading
        title="Объекты обслуживания"
        sub="Системы и оборудование; заказчик хранится строкой в карточке объекта"
        actions={
          <button className="sm-primary" onClick={() => setCreating(true)}>
            + Добавить объект
          </button>
        }
      />
      <div className="sm-filters">
        <input
          placeholder="Поиск по названию, адресу или заказчику"
          aria-label="Поиск объекта"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setQ(e.currentTarget.value.trim());
              setPage(1);
            }
          }}
          onBlur={(e) => {
            setQ(e.currentTarget.value.trim());
            setPage(1);
          }}
        />
        <select
          aria-label="Состояние"
          value={archived ? 'archived' : 'active'}
          onChange={(e) => {
            setArchived(e.target.value === 'archived');
            setPage(1);
          }}
        >
          <option value="active">Действующие объекты</option>
          <option value="archived">Архив</option>
        </select>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        <Table
          headers={['Объект', 'Заказчик', 'Системы', 'Контактное лицо', '']}
          empty={archived ? 'Архив пуст' : 'Объектов пока нет'}
          footer={data && <Pager page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />}
        >
          {data?.items.map((o) => (
            <tr key={o.id}>
              <td>
                <b>{o.name}</b>
                <small>{o.address}</small>
              </td>
              <td>{o.customer_name}</td>
              <td>{count(o.systems_count ?? 0, 'система', 'системы', 'систем')}</td>
              <td>
                {o.contact_name ?? '—'}
                {o.contact_phone && <small>{o.contact_phone}</small>}
              </td>
              <td>
                {o.is_archived && (
                  <>
                    <Badge>В архиве</Badge>{' '}
                  </>
                )}
                <Link className="sm-link" to={`/objects/${o.id}`}>
                  Открыть →
                </Link>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {creating && <ObjectDialog onClose={() => setCreating(false)} onSaved={(o) => navigate(`/objects/${o.id}`)} />}
    </Shell>
  );
}
