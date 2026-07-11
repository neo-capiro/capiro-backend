import { useEffect } from 'react';
import { App, Form, Modal, Radio } from 'antd';
import { NotetakerConsentFields, extractMeetingJoinUrl } from '../meeting-actions.js';
import { useDispatchNotetaker } from './meetings-api.js';
import type { Meeting } from './meetings-types.js';

interface FormValues {
  meetingUrl: string;
  authorizedToRecord: boolean;
  allPartiesWillBeNotified: boolean;
  timing: 'schedule' | 'now';
}

/**
 * "Send Meri to take notes?" — the consent modal (compliance-reviewed copy from
 * NotetakerConsentFields) plus scheduling (spec §4.2): for a future meeting Meri
 * is scheduled against the meeting start (joinAt); for one already underway it
 * joins now.
 */
export function SendMeriModal({
  meeting,
  open,
  onClose,
}: {
  meeting: Meeting | null;
  open: boolean;
  onClose: () => void;
}) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const dispatch = useDispatchNotetaker();
  const authorized = Form.useWatch('authorizedToRecord', form);
  const notified = Form.useWatch('allPartiesWillBeNotified', form);

  const startInFuture = meeting ? new Date(meeting.startsAt).getTime() > Date.now() : false;

  useEffect(() => {
    if (open && meeting) {
      form.setFieldsValue({
        meetingUrl: meeting.joinLink ?? extractMeetingJoinUrl(meeting) ?? '',
        authorizedToRecord: false,
        allPartiesWillBeNotified: false,
        timing: startInFuture ? 'schedule' : 'now',
      });
    }
  }, [open, meeting, startInFuture, form]);

  const submit = async () => {
    if (!meeting) return;
    const values = await form.validateFields();
    await dispatch.mutateAsync({
      meetingId: meeting.id,
      meetingUrl: values.meetingUrl,
      authorizedToRecord: values.authorizedToRecord,
      allPartiesWillBeNotified: values.allPartiesWillBeNotified,
      joinAt: values.timing === 'schedule' ? meeting.startsAt : undefined,
    });
    message.success(
      values.timing === 'schedule' ? 'Meri scheduled for this meeting.' : 'Meri is joining now.',
    );
    onClose();
  };

  return (
    <Modal
      title="Send Meri to take notes?"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="Send Meri"
      confirmLoading={dispatch.isPending}
      okButtonProps={{ disabled: !(authorized && notified) }}
      width={560}
      rootClassName="redesign"
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <NotetakerConsentFields />
        {startInFuture ? (
          <Form.Item name="timing" label="When should Meri join?">
            <Radio.Group>
              <Radio value="schedule">At meeting start (scheduled)</Radio>
              <Radio value="now">Now</Radio>
            </Radio.Group>
          </Form.Item>
        ) : (
          <Form.Item name="timing" hidden>
            <input type="hidden" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
