import { Component, type ReactNode } from 'react';
import { Alert, Button } from './components';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="space-y-3 p-4">
          <Alert tone="red" title="Something went wrong">{this.state.error.message}</Alert>
          <Button onClick={() => { this.setState({ error: null }); location.reload(); }}>Reload</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
