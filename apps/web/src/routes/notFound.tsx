import { useNavigate } from '@tanstack/react-router';
import { StateMessage } from '../components/states';
import { useDocumentTitle } from '../lib/hooks';

export function NotFound() {
  const navigate = useNavigate();
  useDocumentTitle('Not found');
  return (
    <div className="page-narrow">
      <StateMessage
        title="Nothing at this address."
        body="The link may be old, or the book was removed."
        actionLabel="Go to Library"
        onAction={() => void navigate({ to: '/library' })}
      />
    </div>
  );
}
