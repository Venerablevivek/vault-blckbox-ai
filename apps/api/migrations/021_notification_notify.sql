-- Live notifications. Every new notification tells listening API instances, through
-- LISTEN/NOTIFY, whose inbox changed; each instance pushes that to the person's open browser tabs
-- over server-sent events. The payload is only the user id: the browser fetches the notification
-- itself through the normal, authorized endpoint.

CREATE FUNCTION notify_notification_inserted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('notifications', NEW.user_id::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER notifications_notify
  AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notify_notification_inserted();
