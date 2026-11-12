import { useState } from "react";
import { Route, Routes } from "react-router-dom";
import { AcceptInvitationPage } from "./pages/AcceptInvitationPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";

export function App() {
  const [accessToken, setAccessToken] = useState<string | null>(null);

  return (
    <Routes>
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/accept-invitation" element={<AcceptInvitationPage />} />
      <Route path="/login" element={<LoginPage onLogin={setAccessToken} />} />
      <Route path="/home" element={<HomePage isSignedIn={accessToken !== null} />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
