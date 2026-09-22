import DocumentsPanel from '../components/DocumentsPanel';
import type { Session } from '../api';

export default function Documents({ companyId, session }: { companyId: string; session: Session }) {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Documents</h1>
      <p className="text-sm text-slate-600">Registration certificates, PF/ESI documents, labour licences and other company files. Files with an expiry date send a reminder before they lapse.</p>
      <DocumentsPanel basePath={`/companies/${companyId}/documents`} kind="company" canManage={session.user.permissions.includes('documents.manage')} />
    </div>
  );
}
