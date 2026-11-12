import { Link } from "react-router-dom";
import { Page } from "../components/Page";

export function NotFoundPage() {
  return (
    <Page title="Page not found">
      <p><Link to="/login">Go to sign in</Link></p>
    </Page>
  );
}
