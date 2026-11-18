import React, { useMemo, useState } from 'react';
import { Bell, CheckCircle2, Plus, Trash2, CalendarClock } from 'lucide-react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useToast } from '../ToastProvider';
import { clampStr, createScopedDoc, deleteScopedDoc, makeDocId, updateScopedDoc } from '../../lib/firebase';
import type { CampaignTask, NotificationItem } from '../../types/sonicpush';

export const NotificationsView: React.FC = () => {
  const { user, campaigns, songs, mediaContacts, tasks, notifications } = useWorkspace();
  const { notify } = useToast();

  // New Task Form
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDept, setTaskDept] = useState('Campaign Ops');
  const [taskDue, setTaskDue] = useState(new Date().toISOString().slice(0, 10));
  const [taskPriority, setTaskPriority] = useState<CampaignTask['priority']>('medium');
  const [taskCampaignId, setTaskCampaignId] = useState('');

  // New Notification / Reminder Form
  const [notifCategory, setNotifCategory] = useState<NotificationItem['category']>('campaign_deadline');
  const [notifTitle, setNotifTitle] = useState('');
  const [notifMessage, setNotifMessage] = useState('');
  const [notifDate, setNotifDate] = useState(new Date().toISOString().slice(0, 10));

  // Real derived reminders from saved database dates
  const derivedReminders = useMemo(() => {
    const list: Array<{ id: string; type: string; title: string; date: string }> = [];
    songs.forEach((s) => {
      if (s.releaseDate && s.releaseDate !== 'TBD') {
        list.push({
          id: `rel_${s.id}`,
          type: 'Release Date',
          title: `${s.title} (${s.artistName})`,
          date: s.releaseDate,
        });
      }
    });
    mediaContacts.forEach((m) => {
      if (m.followUpDate) {
        list.push({
          id: `fu_${m.id}`,
          type: 'Outreach Follow-Up',
          title: `${m.name} (${m.category})`,
          date: m.followUpDate,
        });
      }
    });
    campaigns.forEach((c) => {
      if (c.endDate && c.status === 'active') {
        list.push({
          id: `camp_${c.id}`,
          type: 'Campaign Deadline',
          title: c.name,
          date: c.endDate,
        });
      }
    });
    return list.sort((a, b) => a.date.localeCompare(b.date));
  }, [songs, mediaContacts, campaigns]);

  const handleAddTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!taskTitle.trim()) return;
    const camp = campaigns.find((c) => c.id === taskCampaignId);
    try {
      await createScopedDoc('campaign_tasks', makeDocId('task'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        ...(camp ? { campaignId: camp.id, campaignName: clampStr(camp.name, 200) } : {}),
        title: clampStr(taskTitle, 220),
        department: clampStr(taskDept, 80),
        dueDate: taskDue,
        priority: taskPriority,
        status: 'todo',
      });
      setTaskTitle('');
      notify('Task created.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Unable to create task.', 'error');
    }
  };

  const handleAddNotif = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!notifTitle.trim() || !notifMessage.trim()) return;
    try {
      await createScopedDoc('notifications', makeDocId('ntf'), {
        organizationId: user.organizationId,
        ownerId: user.uid,
        assignedUserIds: [user.uid],
        category: notifCategory,
        title: clampStr(notifTitle, 180),
        message: clampStr(notifMessage, 600),
        targetDate: notifDate,
        read: false,
      });
      setNotifTitle('');
      setNotifMessage('');
      notify('Reminder alert saved.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save notification.', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">Notifications & Campaign Tasks</h1>
        <p className="text-sm text-zinc-400">
          Track release reminders, outreach follow-ups, campaign deadlines, client updates, and team tasks from saved records.
        </p>
      </div>

      {/* Live Saved-Date Reminders */}
      <div className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-[#FF5500]" />
          <h2 className="font-display text-sm font-semibold text-white">
            Schedule Reminders from Saved Records ({derivedReminders.length})
          </h2>
        </div>
        {derivedReminders.length === 0 ? (
          <p className="text-xs text-zinc-500">
            No release dates, follow-up dates, or active campaign deadlines saved yet.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {derivedReminders.slice(0, 9).map((r) => (
              <div key={r.id} className="rounded-lg border border-white/10 bg-[#18181E] p-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[11px] text-[#FF5500] font-medium">{r.type}</p>
                  <p className="text-xs font-medium text-white truncate">{r.title}</p>
                </div>
                <span className="font-mono-tabular text-xs text-zinc-300 shrink-0">{r.date}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tasks Section */}
        <div className="space-y-4">
          <form
            onSubmit={(e) => void handleAddTask(e)}
            className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-3"
          >
            <h2 className="font-display text-base font-semibold text-white">Assign / Create Task</h2>
            <input
              type="text"
              required
              value={taskTitle}
              onChange={(e) => setTaskTitle(e.target.value)}
              placeholder="Task description *"
              className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <input
                type="text"
                value={taskDept}
                onChange={(e) => setTaskDept(e.target.value)}
                placeholder="Department"
                className="rounded-lg border border-white/10 bg-[#18181E] px-2.5 py-2 text-xs text-white"
              />
              <input
                type="date"
                value={taskDue}
                onChange={(e) => setTaskDue(e.target.value)}
                className="rounded-lg border border-white/10 bg-[#18181E] px-2.5 py-2 text-xs text-white"
              />
              <select
                value={taskPriority}
                onChange={(e) => setTaskPriority(e.target.value as CampaignTask['priority'])}
                className="rounded-lg border border-white/10 bg-[#18181E] px-2.5 py-2 text-xs text-white"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-1 rounded-lg bg-[#FF5500] px-3 py-2 text-xs font-semibold text-white hover:bg-[#e04b00]"
              >
                <Plus className="h-3.5 w-3.5" />
                Add Task
              </button>
            </div>
            {campaigns.length > 0 && (
              <select
                value={taskCampaignId}
                onChange={(e) => setTaskCampaignId(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-zinc-200"
              >
                <option value="">General Workspace Task</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </form>

          <div className="rounded-xl border border-white/10 bg-[#121216] divide-y divide-white/10">
            <div className="p-4">
              <h3 className="font-display text-sm font-semibold text-white">Task Queue ({tasks.length})</h3>
            </div>
            {tasks.length === 0 ? (
              <p className="p-6 text-xs text-zinc-500">No tasks queued.</p>
            ) : (
              tasks.map((t) => (
                <div key={t.id} className="p-4 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className={`text-sm font-medium ${t.status === 'done' ? 'line-through text-zinc-500' : 'text-white'}`}>
                      {t.title}
                    </p>
                    <p className="text-xs text-zinc-400">
                      {t.department} · Priority: {t.priority} · Due <span className="font-mono-tabular">{t.dueDate}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={t.status}
                      onChange={(e) =>
                        void updateScopedDoc('campaign_tasks', t.id, { status: e.target.value })
                      }
                      className="rounded border border-white/10 bg-[#18181E] px-2 py-1 text-xs text-zinc-200"
                    >
                      <option value="todo">To Do</option>
                      <option value="in_progress">In Progress</option>
                      <option value="done">Done</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => void deleteScopedDoc('campaign_tasks', t.id)}
                      className="p-1.5 text-zinc-500 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Notifications Section */}
        <div className="space-y-4">
          <form
            onSubmit={(e) => void handleAddNotif(e)}
            className="rounded-xl border border-white/10 bg-[#121216] p-5 space-y-3"
          >
            <h2 className="font-display text-base font-semibold text-white">Create Notification / Alert</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                value={notifCategory}
                onChange={(e) => setNotifCategory(e.target.value as NotificationItem['category'])}
                className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white"
              >
                <option value="campaign_deadline">Campaign Deadline</option>
                <option value="upcoming_release">Upcoming Release</option>
                <option value="outreach_followup">Outreach Follow-Up</option>
                <option value="client_update">Client Update</option>
                <option value="campaign_completed">Campaign Completion</option>
                <option value="task_assignment">Task Assignment</option>
              </select>
              <input
                type="date"
                value={notifDate}
                onChange={(e) => setNotifDate(e.target.value)}
                className="rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-xs text-white"
              />
            </div>
            <input
              type="text"
              required
              value={notifTitle}
              onChange={(e) => setNotifTitle(e.target.value)}
              placeholder="Alert Title *"
              className="w-full rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
            />
            <div className="flex gap-2">
              <input
                type="text"
                required
                value={notifMessage}
                onChange={(e) => setNotifMessage(e.target.value)}
                placeholder="Alert details *"
                className="flex-1 rounded-lg border border-white/10 bg-[#18181E] px-3 py-2 text-sm text-white"
              />
              <button
                type="submit"
                className="rounded-lg bg-[#8B5CF6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#7C3AED]"
              >
                Save Alert
              </button>
            </div>
          </form>

          <div className="rounded-xl border border-white/10 bg-[#121216] divide-y divide-white/10">
            <div className="p-4 flex items-center gap-2">
              <Bell className="h-4 w-4 text-[#8B5CF6]" />
              <h3 className="font-display text-sm font-semibold text-white">
                Notifications Feed ({notifications.length})
              </h3>
            </div>
            {notifications.length === 0 ? (
              <p className="p-6 text-xs text-zinc-500">No saved notifications yet.</p>
            ) : (
              notifications.map((n) => (
                <div key={n.id} className="p-4 flex items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <p className="text-xs text-[#8B5CF6] capitalize">
                      {n.category.replace(/_/g, ' ')} {n.targetDate ? `· ${n.targetDate}` : ''}
                    </p>
                    <p className={`text-sm font-medium ${n.read ? 'text-zinc-400' : 'text-white'}`}>
                      {n.title}
                    </p>
                    <p className="text-xs text-zinc-400">{n.message}</p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void updateScopedDoc('notifications', n.id, { read: !n.read })}
                      className={`p-1.5 rounded ${n.read ? 'text-zinc-500' : 'text-emerald-400'}`}
                      title={n.read ? 'Mark unread' : 'Mark read'}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteScopedDoc('notifications', n.id)}
                      className="p-1.5 text-zinc-500 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
