import { useEffect } from 'react';
import { CalendarOutlined, DeleteOutlined, EditOutlined, MailOutlined, PhoneOutlined, PlusOutlined, TeamOutlined } from '@ant-design/icons';
import { Button, Form, Input, Modal, Segmented, Select, Skeleton, Space } from 'antd';
import { FacilitiesEditor } from './FacilitiesEditor.js';
import { TargetsTab } from './TargetsTab.js';
import type { Client } from './clientTypes.js';
import { formatDate, optional, type ClientPerson, type RelationshipView } from './client-profile-crm-model.js';

export function Relationships({
  client,
  view,
  setView,
  people,
  loadingPeople,
  targetsCount,
  facilitiesCount,
  canManage,
  onAddPerson,
  onEditPerson,
  onDeletePerson,
  onOpenIntelligence,
}: {
  client: Client;
  view: RelationshipView;
  setView: (view: RelationshipView) => void;
  people: ClientPerson[];
  loadingPeople: boolean;
  targetsCount: number;
  facilitiesCount: number;
  canManage: boolean;
  onAddPerson: () => void;
  onEditPerson: (person: ClientPerson) => void;
  onDeletePerson: (person: ClientPerson) => void;
  onOpenIntelligence: () => void;
}) {
  return (
    <section className="crm-section-shell">
      <div className="crm-section-head">
        <div><h2>Relationships</h2><p>Client people, government relationships and locations.</p></div>
        <Segmented
          value={view}
          options={[
            { label: `Contacts ${people.length}`, value: 'contacts' },
            { label: `Government ${targetsCount}`, value: 'government' },
            { label: `Locations ${facilitiesCount}`, value: 'locations' },
          ]}
          onChange={(value) => setView(value as RelationshipView)}
        />
      </div>
      {view === 'contacts' ? (
        <Contacts
          people={people}
          loading={loadingPeople}
          canManage={canManage}
          onAdd={onAddPerson}
          onEdit={onEditPerson}
          onDelete={onDeletePerson}
        />
      ) : null}
      {view === 'government' ? (
        <TargetsTab clientId={client.id} canManage={canManage} onViewIntelligence={onOpenIntelligence} />
      ) : null}
      {view === 'locations' ? <FacilitiesEditor clientId={client.id} canManage={canManage} /> : null}
    </section>
  );
}

function Contacts({
  people,
  loading,
  canManage,
  onAdd,
  onEdit,
  onDelete,
}: {
  people: ClientPerson[];
  loading: boolean;
  canManage: boolean;
  onAdd: () => void;
  onEdit: (person: ClientPerson) => void;
  onDelete: (person: ClientPerson) => void;
}) {
  return (
    <div className="crm-card">
      <div className="crm-card__header">
        <h3>Client contacts</h3><span className="crm-card__grow" />
        {canManage ? <Button type="primary" size="small" icon={<PlusOutlined />} onClick={onAdd}>Add contact</Button> : null}
      </div>
      {loading ? (
        <div className="crm-card__body"><Skeleton active paragraph={{ rows: 4 }} /></div>
      ) : people.length ? (
        <div className="crm-contact-grid">
          {people.map((person) => (
            <article key={person.id} className="crm-contact-card">
              <div className="crm-contact-card__top">
                <span className="crm-avatar">{initials(person.name)}</span>
                <span className="crm-contact-card__identity"><b>{person.name}</b><small>{person.title ?? 'No title'}</small></span>
                {person.role ? <span className="crm-inline-tag">{person.role}</span> : null}
              </div>
              <div className="crm-contact-card__details">
                {person.email ? <a href={`mailto:${person.email}`}><MailOutlined /> {person.email}</a> : null}
                {person.phone ? <a href={`tel:${person.phone.replace(/[^\d+]/g, '')}`}><PhoneOutlined /> {person.phone}</a> : null}
                {person.lastContact ? <span><CalendarOutlined /> Last contact {formatDate(person.lastContact)}</span> : null}
                {person.notes ? <p>{person.notes}</p> : null}
              </div>
              {canManage ? (
                <div className="crm-contact-card__actions">
                  <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(person)}>Edit</Button>
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => onDelete(person)}>Remove</Button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="crm-empty-state"><TeamOutlined /><h3>No contacts yet</h3><p>Add the people who own decisions and day-to-day work.</p>{canManage ? <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>Add contact</Button> : null}</div>
      )}
    </div>
  );
}

export function PersonModal({
  open,
  person,
  submitting,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  person: ClientPerson | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [form] = Form.useForm();
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      name: person?.name,
      title: person?.title,
      email: person?.email,
      phone: person?.phone,
      role: person?.role,
      lastContact: person?.lastContact?.slice(0, 10),
      notes: person?.notes,
    });
  }, [form, open, person]);
  return (
    <Modal
      title={person ? 'Edit contact' : 'Add contact'}
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={submitting}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => onSubmit({
          name: values.name,
          title: optional(values.title),
          email: optional(values.email),
          phone: optional(values.phone),
          role: optional(values.role),
          lastContact: optional(values.lastContact),
          notes: optional(values.notes),
        })}
      >
        <Form.Item name="name" label="Full name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="title" label="Title"><Input /></Form.Item>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="email" label="Email" rules={[{ type: 'email' }]}><Input /></Form.Item>
          <Form.Item name="phone" label="Phone"><Input /></Form.Item>
        </Space>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="role" label="Relationship"><Select allowClear options={['Primary POC', 'Executive', 'Government Affairs', 'BD', 'Technical', 'Legal', 'Finance'].map((value) => ({ label: value, value }))} /></Form.Item>
          <Form.Item name="lastContact" label="Last contact"><Input type="date" /></Form.Item>
        </Space>
        <Form.Item name="notes" label="Notes"><Input.TextArea rows={3} /></Form.Item>
      </Form>
    </Modal>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1
    ? `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase()
    : (parts[0] ?? 'CL').slice(0, 2).toUpperCase();
}
