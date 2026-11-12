import { Navigate } from "react-router-dom";
import { Page } from "../components/Page";

export function HomePage({ isSignedIn }: { isSignedIn: boolean }) {
  if (!isSignedIn) return <Navigate to="/login" replace />;

  return (
    <Page title="Home">
      <p role="status">You are signed in.</p>
    </Page>
  );
}
