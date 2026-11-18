import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import type { UserRole } from './lib/domain';
import { LoginPage } from './pages/LoginPage';
import { StudentPortalPage } from './pages/StudentPortalPage';
import { AdminDashboardPage } from './pages/AdminDashboardPage';
import { GraderDashboardPage } from './pages/GraderDashboardPage';
import { LiveScoringPage } from './pages/LiveScoringPage';
import { ResultsPage } from './pages/ResultsPage';

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="max-w-md rounded-lg border border-red-200 bg-white p-6 text-center">
            <h1 className="font-display text-lg font-bold text-slate-900">
              Đã xảy ra lỗi giao diện
            </h1>
            <p className="mt-2 text-sm text-slate-600">{this.state.message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white"
            >
              Tải lại trang
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function getDefaultRouteForRole(role: UserRole): string {
  if (role === 'STUDENT') return '/student';
  if (role === 'GRADER') return '/grader';
  return '/admin';
}

function ProtectedRoute({
  allowedRoles,
  children,
}: {
  allowedRoles: UserRole[];
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Đang kiểm tra phiên đăng nhập...
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (!allowedRoles.includes(user.role)) {
    return <Navigate to={getDefaultRouteForRole(user.role)} replace />;
  }
  return <>{children}</>;
}

function RootRedirect() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-500">
        Đang khởi tạo Lớp 12A17...
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={getDefaultRouteForRole(user.role)} replace />;
}

export default function App() {
  return (
    <AppErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route
              path="/student"
              element={
                <ProtectedRoute allowedRoles={['STUDENT']}>
                  <StudentPortalPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/grader"
              element={
                <ProtectedRoute allowedRoles={['GRADER']}>
                  <GraderDashboardPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <ProtectedRoute allowedRoles={['SUPER_ADMIN', 'TEACHER']}>
                  <AdminDashboardPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/score/:roomId"
              element={
                <ProtectedRoute allowedRoles={['SUPER_ADMIN', 'TEACHER', 'GRADER']}>
                  <LiveScoringPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/results/:roomId"
              element={
                <ProtectedRoute allowedRoles={['SUPER_ADMIN', 'TEACHER', 'GRADER', 'STUDENT']}>
                  <ResultsPage />
                </ProtectedRoute>
              }
            />
            <Route path="/" element={<RootRedirect />} />
            <Route path="*" element={<RootRedirect />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </AppErrorBoundary>
  );
}
