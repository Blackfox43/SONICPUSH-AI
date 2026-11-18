import React, { useState } from 'react';
import { X, Send, Sparkles } from 'lucide-react';
import { useWorkspace } from '../context/WorkspaceContext';
import { postJsonApi } from '../lib/api';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const STARTER_QUESTIONS = [
  'How do I promote this song?',
  'Create a 30-day TikTok campaign',
  'How can I introduce this artist to the Nigerian market?',
  'Develop an international campaign for this Afrobeats release',
  'Create a DJ outreach strategy',
  'Why is this campaign underperforming?',
  'Generate 20 promotional video ideas',
  'Prepare a professional campaign report',
];

export const AiAssistantDrawer: React.FC = () => {
  const {
    assistantOpen,
    setAssistantOpen,
    artists,
    songs,
    campaigns,
    metrics,
    tasks,
    currency,
    logAiUsage,
  } = useWorkspace();

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content:
        'I am the SONICPUSH AI Strategist—connected to your live artists, songs, campaigns, and logged metrics. Ask for Nigerian, African, or international music marketing strategies grounded strictly in your saved data.',
    },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);

  if (!assistantOpen) return null;

  const sendPrompt = async (promptText: string) => {
    const trimmed = promptText.trim();
    if (!trimmed || loading) return;

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: trimmed }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      const workspaceContext = {
        currency,
        artists: artists.slice(0, 15).map((a) => ({
          name: a.name,
          country: a.country,
          city: a.city,
          genre: a.genre,
          careerStage: a.careerStage,
          objectives: a.marketingObjectives,
        })),
        songs: songs.slice(0, 15).map((s) => ({
          title: s.title,
          artistName: s.artistName,
          genre: s.genre,
          language: s.language,
          releaseDate: s.releaseDate,
          audioProcessed: s.audioProcessed,
          message: s.message,
        })),
        campaigns: campaigns.slice(0, 10).map((c) => ({
          name: c.name,
          artistName: c.artistName,
          type: c.campaignType,
          durationDays: c.durationDays,
          currency: c.currency,
          budget: c.budget,
          status: c.status,
          targetMarkets: c.targetMarkets,
        })),
        metricsSummaryCount: metrics.length,
        recentMetrics: metrics.slice(0, 20),
        openTasks: tasks.filter((t) => t.status !== 'done').slice(0, 15),
      };

      const res = await postJsonApi<{ reply: string; latencyMs: number; model: string }>(
        '/api/ai/assistant',
        {
          messages: nextMessages,
          workspaceContext,
        }
      );

      void logAiUsage('ai_assistant', res.model || 'gemini-4-hydrogen', 'success', res.latencyMs || 0);
      setMessages([...nextMessages, { role: 'assistant', content: res.reply }]);
    } catch (err) {
      void logAiUsage('ai_assistant', 'gemini-4-hydrogen', 'error', 0);
      setMessages([
        ...nextMessages,
        {
          role: 'assistant',
          content:
            err instanceof Error
              ? `Unable to reach SONICPUSH AI: ${err.message}`
              : 'Unable to process request right now.',
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 no-print">
      <div className="w-full max-w-lg bg-[#09090B] border-l border-white/10 h-full flex flex-col">
        <div className="px-5 h-16 border-b border-white/10 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-[#FF5500]" />
            <div>
              <h2 className="font-display text-sm font-bold text-white">SONICPUSH AI Strategist</h2>
              <p className="text-[11px] text-zinc-400">
                Grounded in {artists.length} artists · {songs.length} songs · {campaigns.length} campaigns
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAssistantOpen(false)}
            className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5"
            aria-label="Close AI Assistant"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Starter Prompts */}
        <div className="px-4 py-3 border-b border-white/10 flex gap-2 overflow-x-auto shrink-0">
          {STARTER_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => void sendPrompt(q)}
              disabled={loading}
              className="px-2.5 py-1.5 text-[11px] rounded-lg border border-white/10 bg-[#121216] text-zinc-300 hover:border-[#FF5500] hover:text-white whitespace-nowrap shrink-0"
            >
              {q}
            </button>
          ))}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((m, idx) => (
            <div
              key={idx}
              className={`rounded-xl p-3.5 text-xs sm:text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === 'user'
                  ? 'bg-[#FF5500]/15 border border-[#FF5500]/30 text-white ml-8'
                  : 'bg-[#121216] border border-white/10 text-zinc-200 mr-4'
              }`}
            >
              {m.content}
            </div>
          ))}
          {loading && (
            <div className="rounded-xl p-3.5 text-xs bg-[#121216] border border-white/10 text-zinc-400 mr-4">
              Analyzing your workspace records and drafting strategy...
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendPrompt(input);
          }}
          className="p-4 border-t border-white/10 flex items-center gap-2 shrink-0"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about campaigns, Nigerian/global rollout, DJs, or metrics..."
            className="flex-1 rounded-lg border border-white/10 bg-[#121216] px-3.5 py-2.5 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-[#FF5500]"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="inline-flex items-center justify-center h-10 w-10 rounded-lg bg-[#FF5500] text-white hover:bg-[#e04b00] disabled:opacity-50 shrink-0"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
};
