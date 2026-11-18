import React, { useMemo, useState } from 'react';
import { Radio, Plus, Send, Copy, Trash2, CheckCircle2 } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { postJsonApi } from '../../lib/api';
import { clampStr, createScopedDoc, deleteScopedDoc, makeDocId, updateScopedDoc } from '../../lib/firebase';
import type { MediaCategory, MediaContact } from '../../types/sonicpush';

const MEDIA_CATEGORIES: MediaCategory[] = [
  'DJs',
  'Radio stations',
  'Radio presenters',
  'Music bloggers',
  'Entertainment journalists',
  'Music magazines',
  'Playlist curators',
  'Event organizers',
  'Music influencers',
];

export const MediaOutreachView: React.FC = () => {
  const { user, artists, songs, mediaContacts, outreachHistory, logAiUsage } = useWorkspace();
  const { notify } = useToast();

  const [tab, setTab] = useState<'directory' | 'history'>('directory');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<MediaCategory>('DJs');
  const [country, setCountry] = useState('Nigeria');
  const [location, setLocation] = useState('Lagos');
  const [platform, setPlatform] = useState('Radio / Club / IG');
  const [publicContact, setPublicContact] = useState('');
  const [followUpDate, setFollowUpDate] = useState('');
  const [saving, setSaving] = useState(false);

  // Outreach Composer Modal State
  const [activeContact, setActiveContact] = useState<MediaContact | null>(null);
  const [channel, setChannel] = useState<'WhatsApp' | 'Instagram DM' | 'Email'>('WhatsApp');
  const [draftSubject, setDraftSubject] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [userAuthorized, setUserAuthorized] = useState(false);

  const filteredContacts = useMemo(() => {
    if (categoryFilter === 'ALL') return mediaContacts;
    return mediaContacts.filter((c) => c.category === categoryFilter);
  }, [mediaContacts, categoryFilter]);

  const handleAddContact = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createScopedDoc('media_contacts', makeDocId('med'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        name: clampStr(name, 160),
        category,
        country: clampStr(country, 80),
        ...(location.trim() ? { location: clampStr(location, 120) } : {}),
        platform: clampStr(platform, 100),
        ...(publicContact.trim() ? { publicContact: clampStr(publicContact, 240) } : {}),
        outreachStatus: 'not_contacted',
        ...(followUpDate ? { followUpDate } : {}),
      });
      setName('');
      setPublicContact('');
      setFollowUpDate('');
      notify('Media / DJ contact saved.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save contact.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const openComposer = (c: MediaContact) => {
    setActiveContact(c);
    setDraftSubject('');
    setDraftBody('');
    setUserAuthorized(false);
  };

  const handleGenerateMessage = async () => {
    if (!activeContact) return;
    const artist = artists.find((a) => !a.archived);
    if (!artist) {
      notify('Add an artist profile first to draft outreach messages.', 'error');
      return;
    }
    const song = songs.find((s) => s.artistId === artist.id);
    setDrafting(true);
    try {
      const res = await postJsonApi<{
        subject: string;
        messageBody: string;
        latencyMs: number;
        model: string;
      }>('/api/ai/outreach-draft', {
        contactName: activeContact.name,
        contactCategory: activeContact.category,
        platform: activeContact.platform,
        country: activeContact.country,
        channel,
        artistName: artist.name,
        songTitle: song?.title || '',
        genre: artist.genre,
        streamingLink: song?.streamingLink || '',
        deliverableGoal: `Introduce release for ${activeContact.category} review without promising guaranteed placement`,
      });
      void logAiUsage('media_outreach_draft', res.model || 'gemini-4-hydrogen', 'success', res.latencyMs || 0);
      setDraftSubject(res.subject || '');
      setDraftBody(res.messageBody || '');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to draft outreach message.', 'error');
    } finally {
      setDrafting(false);
    }
  };

  const handleLogAuthorizedOutreach = async () => {
    if (!activeContact || !draftBody.trim() || !userAuthorized) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      await createScopedDoc('outreach_history', makeDocId('out'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        contactId: activeContact.id,
        contactName: clampStr(activeContact.name, 160),
        channel,
        ...(draftSubject.trim() ? { subject: clampStr(draftSubject, 200) } : {}),
        messageBody: clampStr(draftBody, 4000),
        userAuthorized: true,
        outcome: 'Authorized & logged for manual send',
      });
      await updateScopedDoc('media_contacts', activeContact.id, {
        outreachStatus: 'pitched',
        lastContactDate: today,
      });
      setActiveContact(null);
      notify('Outreach message logged with user authorization.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to log outreach.', 'error');
    }
  };

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(
        draftSubject ? `Subject: ${draftSubject}\n\n${draftBody}` : draftBody
      );
      notify('Message copied to clipboard.', 'info');
    } catch {
      notify('Copy failed—select text manually.', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">DJ, Radio & Media Promotion</h1>
          <p className="text-sm text-zinc-400">
            Manage DJs, radio presenters, press, bloggers, and event organizers. Messages require explicit human authorization—never sent automatically or promising guaranteed airplay.
          </p>
        </div>

        <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#121216] border border-white/10">
          <button
            type="button"
            onClick={() => setTab('directory')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              tab === 'directory' ? 'bg-[#FF5500] text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Contacts ({mediaContacts.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('history')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md ${
              tab === 'history' ? 'bg-[#FF5500] text-white' : 'text-zinc-400 hover:text-white'
            }`}
          >
            Outreach History ({outreachHistory.length})
          </button>
        </div>
      </div>

      {tab === 'history' ? (
        <div className="rounded-xl border border-white/10 bg-[#121216] divide-y divide-white/10">
          {outreachHistory.length === 0 ? (
            <p className="p-8 text-center text-sm text-zinc-400">
              No outreach logs recorded yet. Draft and authorize a message from the Contacts tab.
            </p>
          ) : (
            outreachHistory.map((item) => (
              <div key={item.id} className="p-4 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-white">
                    {item.contactName} · {item.channel}
                  </span>
                  <span className="text-emerald-400 inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    User Authorized
                  </span>
                </div>
                {item.subject && <p className="text-xs text-zinc-300 font-medium">Subject: {item.subject}</p>}
                <p className="text-xs text-zinc-400 whitespace-pre-wrap">{item.messageBody}</p>
              </div>
            ))
          )}
        </div>
      ) : (
        <>
          <form
            onSubmit={(e) => void handleAddContact(e)}
            className="rounded-xl border border-white/10 bg-[#121216] p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3"
          >
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contact / Outlet Name *"
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as MediaCategory)}
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            >
              {MEDIA_CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="Country"
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="City / Station"
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <input
              type="text"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              placeholder="Primary Platform"
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <input
              type="text"
              value={publicContact}
              onChange={(e) => setPublicContact(e.target.value)}
              placeholder="Public Email / WhatsApp / Handle"
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <input
              type="date"
              value={followUpDate}
              onChange={(e) => setFollowUpDate(e.target.value)}
              title="Follow-up reminder date"
              className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#FF5500] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e04b00]"
            >
              <Plus className="h-4 w-4" />
              Add Contact
            </button>
          </form>

          {/* Category Filter */}
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setCategoryFilter('ALL')}
              className={`px-3 py-1.5 text-xs rounded-lg border ${
                categoryFilter === 'ALL'
                  ? 'border-[#FF5500] bg-[#FF5500]/15 text-white'
                  : 'border-white/10 bg-[#121216] text-zinc-400'
              }`}
            >
              All Categories
            </button>
            {MEDIA_CATEGORIES.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`px-3 py-1.5 text-xs rounded-lg border ${
                  categoryFilter === cat
                    ? 'border-[#FF5500] bg-[#FF5500]/15 text-white'
                    : 'border-white/10 bg-[#121216] text-zinc-400'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          {filteredContacts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/15 bg-[#121216] p-10 text-center space-y-2">
              <Radio className="h-6 w-6 text-zinc-500 mx-auto" />
              <p className="font-display text-base font-semibold text-white">No contacts in this category</p>
              <p className="text-sm text-zinc-400">
                Add verified DJs, radio stations, presenters, or music journalists above.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-white/10 bg-[#121216] overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/10 text-xs text-zinc-400">
                    <th className="py-3 px-4 font-medium">Contact</th>
                    <th className="py-3 px-4 font-medium">Category</th>
                    <th className="py-3 px-4 font-medium">Location</th>
                    <th className="py-3 px-4 font-medium">Status</th>
                    <th className="py-3 px-4 font-medium">Follow-Up</th>
                    <th className="py-3 px-4 font-medium text-right">Outreach</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10 text-sm">
                  {filteredContacts.map((c) => (
                    <tr key={c.id} className="hover:bg-white/[0.02]">
                      <td className="py-3 px-4">
                        <p className="font-medium text-white">{c.name}</p>
                        <p className="text-xs text-zinc-500">{c.publicContact || c.platform}</p>
                      </td>
                      <td className="py-3 px-4 text-xs text-zinc-300">{c.category}</td>
                      <td className="py-3 px-4 text-xs text-zinc-400">
                        {c.location ? `${c.location}, ` : ''}
                        {c.country}
                      </td>
                      <td className="py-3 px-4">
                        <select
                          value={c.outreachStatus}
                          onChange={(e) =>
                            void updateScopedDoc('media_contacts', c.id, {
                              outreachStatus: e.target.value,
                            })
                          }
                          className="rounded border border-white/10 bg-[#18181E] px-2 py-1 text-xs text-zinc-200"
                        >
                          <option value="not_contacted">Not Contacted</option>
                          <option value="pitched">Pitched</option>
                          <option value="follow_up_due">Follow-up Due</option>
                          <option value="responded">Responded</option>
                          <option value="confirmed">Confirmed</option>
                          <option value="declined">Declined</option>
                        </select>
                      </td>
                      <td className="py-3 px-4 font-mono-tabular text-xs text-zinc-400">
                        {c.followUpDate || '—'}
                      </td>
                      <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => openComposer(c)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-[#8B5CF6]/40 bg-[#8B5CF6]/10 text-zinc-100 hover:bg-[#8B5CF6]/20"
                        >
                          <Send className="h-3 w-3" />
                          Draft Pitch
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteScopedDoc('media_contacts', c.id)}
                          className="p-1.5 text-zinc-500 hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Outreach Drafting & Human Authorization Modal */}
      {activeContact && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-xl border border-white/15 bg-[#121216] p-6 space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-[#FF5500] font-medium">{activeContact.category}</p>
                <h2 className="font-display text-lg font-bold text-white">
                  Outreach Message for {activeContact.name}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setActiveContact(null)}
                className="text-xs text-zinc-400 hover:text-white"
              >
                Close
              </button>
            </div>

            <div className="flex items-center gap-2">
              {(['WhatsApp', 'Instagram DM', 'Email'] as const).map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => setChannel(ch)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                    channel === ch
                      ? 'border-[#FF5500] bg-[#FF5500]/15 text-white'
                      : 'border-white/10 bg-[#18181E] text-zinc-400'
                  }`}
                >
                  {ch}
                </button>
              ))}
              <button
                type="button"
                onClick={() => void handleGenerateMessage()}
                disabled={drafting}
                className="ml-auto px-3 py-1.5 text-xs font-semibold rounded-lg bg-[#8B5CF6] text-white hover:bg-[#7C3AED] disabled:opacity-60"
              >
                {drafting ? 'Drafting...' : 'Generate AI Draft'}
              </button>
            </div>

            {channel === 'Email' && (
              <input
                type="text"
                value={draftSubject}
                onChange={(e) => setDraftSubject(e.target.value)}
                placeholder="Email Subject Line"
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
            )}

            <textarea
              rows={7}
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder="Generate an AI pitch or write your outreach message..."
              className="w-full rounded-lg border border-white/10 bg-[#18181E] p-3 text-sm text-white"
            />

            <label className="flex items-start gap-2.5 text-xs text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={userAuthorized}
                onChange={(e) => setUserAuthorized(e.target.checked)}
                className="mt-0.5 accent-[#FF5500]"
              />
              <span>
                I confirm this message is reviewed and authorized by me, makes no guaranteed airplay or payola claims, and is ready to copy/send manually.
              </span>
            </label>

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => void copyMessage()}
                disabled={!draftBody.trim()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-white/15 text-zinc-200 hover:bg-white/5 disabled:opacity-50"
              >
                <Copy className="h-3.5 w-3.5" />
                Copy Message
              </button>
              <button
                type="button"
                onClick={() => void handleLogAuthorizedOutreach()}
                disabled={!draftBody.trim() || !userAuthorized}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-50"
              >
                Authorize & Log Pitch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
