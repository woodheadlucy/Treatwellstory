import { useState, useRef } from 'react';
import { Button } from './ui/button';
import { Upload, X, AlertCircle, CheckCircle2, Image as ImageIcon, Video, Loader2, ArrowLeft, Sparkles, BarChart3, Shield } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UploadedMedia {
  id: string;
  file: File;
  url: string;
  type: 'image' | 'video';
  status: 'analyzing' | 'approved' | 'rejected' | 'error';
  aiAnalysis?: {
    contentType: string[];
    tags: string[];
    moderationStatus: 'safe' | 'unsafe';
    moderationReasons?: string[];
    confidence: number;
    flaggedCategories: {
      nudity: boolean;
      profanity: boolean;
      violence: boolean;
      illegalItems: boolean;
      contactInfo: boolean;
      offTopicContent: boolean;
    };
  };
  error?: string;
}

// ─── AI Moderation Helpers ────────────────────────────────────────────────────

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function extractVideoFrame(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    video.src = url;
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.addEventListener('loadeddata', () => {
      video.currentTime = Math.min(1, video.duration * 0.1);
    });
    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 360;
        canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
      } catch (e) {
        reject(e);
      }
    });
    video.addEventListener('error', reject);
    video.load();
  });
}

async function analyzeMediaWithClaude(file: File): Promise<UploadedMedia['aiAnalysis']> {
  const isVideo = file.type.startsWith('video/');
  const mediaType = isVideo ? 'image/jpeg' : file.type;
  const base64Data = isVideo ? await extractVideoFrame(file) : await fileToBase64(file);
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined;
  const model =
    (import.meta.env.VITE_ANTHROPIC_MODEL as string | undefined) ??
    'claude-sonnet-4-20250514';

  if (!apiKey) {
    throw new Error('Missing VITE_ANTHROPIC_API_KEY. Add it to your .env and restart the dev server.');
  }

  const systemPrompt = `You are a professional content moderation AI for a beauty & wellness marketplace called Treatwell.
Analyse the image and return a structured JSON response.

Check for:
1. Nudity or sexual content (any level)
2. Profanity or offensive text visible in the image
3. Violence or gore
4. Drugs, weapons, or illegal items
5. Contact information (phone numbers, emails, social media handles)
6. Off-topic content — this platform only allows: haircuts, hair colouring, manicures, pedicures, facials, massages, makeup, hair styling, skincare, waxing, brow/lash treatments

Respond ONLY with a valid JSON object — no markdown, no code fences, no extra text:
{
  "moderationStatus": "safe",
  "moderationReasons": [],
  "contentType": "e.g. Hair Colouring",
  "tags": ["tag1", "tag2", "tag3"],
  "confidence": 0.95,
  "flaggedCategories": {
    "nudity": false,
    "profanity": false,
    "violence": false,
    "illegalItems": false,
    "contactInfo": false,
    "offTopicContent": false
  }
}

Set moderationStatus to "unsafe" and populate moderationReasons with clear user-friendly explanations if any category is flagged.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data },
            },
            {
              type: 'text',
              text: isVideo
                ? 'This is a frame extracted from a video upload. Please moderate it.'
                : 'Please moderate this image upload.',
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    if (response.status === 404) {
      throw new Error(
        `Moderation API error (404): model "${model}" not found for this API key. ` +
        `Double-check VITE_ANTHROPIC_MODEL against the /v1/models list. Raw: ${err}`
      );
    }
    throw new Error(`Moderation API error (${response.status}): ${err}`);
  }

  const data = await response.json();
  const raw = data.content.map((b: { text?: string }) => b.text ?? '').join('');
  const clean = raw.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);

  return {
    contentType: [parsed.contentType ?? 'Unknown'],
    tags: parsed.tags ?? [],
    moderationStatus: parsed.moderationStatus,
    moderationReasons: parsed.moderationReasons ?? [],
    confidence: parsed.confidence ?? 0.9,
    flaggedCategories: parsed.flaggedCategories ?? {
      nudity: false,
      profanity: false,
      violence: false,
      illegalItems: false,
      contactInfo: false,
      offTopicContent: false,
    },
  };
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function StoryUploadModal({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [uploadedMedia, setUploadedMedia] = useState<UploadedMedia[]>([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const [showSuccessDialog, setShowSuccessDialog] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) return;

    // Clear existing media
    uploadedMedia.forEach(media => URL.revokeObjectURL(media.url));

    const url = URL.createObjectURL(file);
    const newMedia: UploadedMedia = {
      id: Math.random().toString(36).substring(7),
      file,
      url,
      type: isImage ? 'image' : 'video',
      status: 'analyzing',
    };

    setUploadedMedia([newMedia]);

    if (fileInputRef.current) fileInputRef.current.value = '';

    // Real AI moderation
    try {
      const analysis = await analyzeMediaWithClaude(file);
      setUploadedMedia(prev =>
        prev.map(m =>
          m.id !== newMedia.id ? m : {
            ...m,
            status: analysis!.moderationStatus === 'safe' ? 'approved' : 'rejected',
            aiAnalysis: analysis,
          }
        )
      );
    } catch (err) {
      setUploadedMedia(prev =>
        prev.map(m =>
          m.id !== newMedia.id ? m : {
            ...m,
            status: 'error',
            error: (err as Error).message,
          }
        )
      );
    }
  };

  const removeMedia = (id: string) => {
    setUploadedMedia(prev => {
      const media = prev.find(m => m.id === id);
      if (media) URL.revokeObjectURL(media.url);
      return prev.filter(m => m.id !== id);
    });
  };

  const handlePublish = async () => {
    const approvedMedia = uploadedMedia.filter(m => m.status === 'approved');
    if (approvedMedia.length > 0) {
      setIsPublishing(true);
      await new Promise(resolve => setTimeout(resolve, 2000));
      setIsPublishing(false);
      setShowSuccessDialog(true);
    }
  };

  const handleSuccessClose = () => {
    setShowSuccessDialog(false);
    setUploadedMedia([]);
    onOpenChange(false);
  };

  const approvedCount = uploadedMedia.filter(m => m.status === 'approved').length;
  const analyzingCount = uploadedMedia.filter(m => m.status === 'analyzing').length;

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-background z-50 flex flex-col">

      {/* Success Dialog */}
      {showSuccessDialog && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4">
          <div className="bg-card border border-border rounded-[var(--radius-card)] p-8 max-w-md w-full shadow-2xl">
            <div className="text-center">
              <div className="mx-auto mb-6 w-20 h-20 bg-chart-2/20 rounded-full flex items-center justify-center">
                <CheckCircle2 size={48} className="text-chart-2" />
              </div>
              <h2 className="mb-3" style={{ fontSize: '24px', fontWeight: 'var(--font-weight-medium)' }}>
                🎉 Your Stories Are Going Live!
              </h2>
              <p className="text-muted-foreground mb-6" style={{ fontSize: '16px', lineHeight: '1.6' }}>
                Amazing! Your stories will appear on the Treatwell marketplace in the next few minutes and start attracting customers.
              </p>
              <div className="bg-primary/10 border border-primary/30 rounded-[var(--radius-lg)] p-5 mb-6 text-left">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <BarChart3 size={20} className="text-primary" />
                  </div>
                  <div>
                    <h4 className="text-foreground mb-1.5" style={{ fontSize: '15px', fontWeight: 'var(--font-weight-medium)' }}>
                      Track Your Success
                    </h4>
                    <p className="text-muted-foreground" style={{ fontSize: '14px', lineHeight: '1.5' }}>
                      Visit the <strong className="text-foreground">Reports</strong> section to see how many customers viewed your stories and placed bookings. Watch your engagement grow! 📈
                    </p>
                  </div>
                </div>
              </div>
              <Button onClick={handleSuccessClose} className="w-full" size="lg">Done</Button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="border-b border-border bg-background">
        <div className="max-w-[1600px] mx-auto px-8 py-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} className="rounded-full">
              <ArrowLeft size={20} />
            </Button>
            <div>
              <h1 className="text-foreground" style={{ fontSize: '24px', fontWeight: 'var(--font-weight-semibold)' }}>
                Story Showcase - Upload Content
              </h1>
            </div>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handlePublish} disabled={approvedCount === 0 || analyzingCount > 0}>
              {isPublishing ? <Loader2 size={20} className="animate-spin" /> : 'Publish'}
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-[1600px] mx-auto px-8 py-8">

          {/* Conditional Banner */}
          {uploadedMedia.length === 0 ? (
            <div className="bg-primary/10 border-l-4 border-primary rounded-[var(--radius)] p-6 mb-8">
              <div className="flex items-start gap-4">
                <div className="bg-primary text-primary-foreground rounded-full p-3 mt-0.5">
                  <ImageIcon size={28} />
                </div>
                <div>
                  <h4 className="mb-2" style={{ fontSize: '20px', fontWeight: 'var(--font-weight-medium)' }}>
                    Publish to Treatwell Marketplace
                  </h4>
                  <p className="text-muted-foreground" style={{ fontSize: '16px', lineHeight: '1.6' }}>
                    Your content will be displayed to thousands of potential customers browsing Treatwell.
                    High-quality stories help attract new customers and showcase your best work to people actively looking to book treatments.
                  </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-primary/10 border-l-4 border-primary rounded-[var(--radius)] p-6 mb-8">
              <div className="flex items-start gap-4">
                <div className="bg-primary text-primary-foreground rounded-full p-3 mt-0.5">
                  <Sparkles size={28} />
                </div>
                <div className="flex-1">
                  <h4 className="mb-2" style={{ fontSize: '20px', fontWeight: 'var(--font-weight-medium)' }}>
                    AI-Powered Customer Matching
                  </h4>
                  <p className="text-muted-foreground mb-3" style={{ fontSize: '16px', lineHeight: '1.6' }}>
                    Your stories will be shown to customers most likely to book your services.
                  </p>
                  <div className="bg-card/50 rounded-[var(--radius)] p-4">
                    <p className="text-foreground" style={{ fontSize: '15px', lineHeight: '1.6' }}>
                      <span style={{ fontWeight: 'var(--font-weight-medium)' }}>Reach new customers</span> based on their preferences, location, and booking history.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Conditional Layout */}
          {uploadedMedia.length === 0 ? (
            <div className="grid grid-cols-[1fr_420px] gap-10 mb-8">
              {/* Upload Area */}
              <div>
                <div
                  className="border-2 border-dashed border-border rounded-[var(--radius)] p-16 text-center cursor-pointer hover:border-primary transition-colors min-h-[400px] flex flex-col items-center justify-center"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="mx-auto mb-8 text-muted-foreground" size={72} />
                  <p className="mb-4" style={{ fontSize: '20px', fontWeight: 'var(--font-weight-medium)' }}>
                    Click to upload or drag and drop
                  </p>
                  <p className="text-muted-foreground" style={{ fontSize: '16px' }}>
                    Images (PNG, JPG) or Videos (MP4, MOV, max 10 seconds) - Max 50MB
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*"
                    className="hidden"
                    onChange={handleFileSelect}
                  />
                </div>
              </div>

              {/* Guidelines */}
              <div className="bg-card border border-border rounded-[var(--radius)] p-7 h-fit sticky top-8">
                <h4 className="mb-6" style={{ fontSize: '20px', fontWeight: 'var(--font-weight-medium)' }}>
                  📋 Upload Guidelines
                </h4>
                <ul className="space-y-5" style={{ fontSize: '16px', lineHeight: '1.6' }}>
                  {[
                    ['Vertical format', 'Content must be in vertical/portrait orientation (9:16 ratio recommended)'],
                    ['High quality', 'Upload clear, well-lit, high-resolution images and videos'],
                    ['No contact information', "Don't include phone numbers, email addresses, or external social media handles"],
                    ['Appropriate content only', 'No medical procedures, nudity, or sensitive content'],
                  ].map(([title, desc], i) => (
                    <li key={i} className="flex items-start gap-4">
                      <span
                        className="bg-primary text-primary-foreground rounded-full w-7 h-7 flex items-center justify-center flex-shrink-0 mt-0.5"
                        style={{ fontSize: '14px', fontWeight: 'var(--font-weight-medium)' }}
                      >
                        {i + 1}
                      </span>
                      <div>
                        <strong className="text-foreground">{title}:</strong>
                        <span className="text-muted-foreground"> {desc}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-[400px_1fr] gap-8 mb-8">
              {/* Left: Media Preview */}
              <div>
                {uploadedMedia.map(media => (
                  <CompactMediaPreview key={media.id} media={media} onRemove={() => removeMedia(media.id)} />
                ))}
              </div>

              {/* Right: AI Analysis */}
              <div>
                {uploadedMedia.map(media => (
                  <AIAnalysisPanel key={media.id} media={media} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer Status Bar */}
      {approvedCount > 0 && (
        <div className="border-t border-border bg-muted/30">
          <div className="max-w-[1600px] mx-auto px-8 py-4">
            <p className="text-muted-foreground" style={{ fontSize: '15px' }}>
              {approvedCount} item{approvedCount !== 1 ? 's' : ''} ready to publish
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CompactMediaPreview (unchanged from original) ────────────────────────────

interface CompactMediaPreviewProps {
  media: UploadedMedia;
  onRemove: () => void;
}

function CompactMediaPreview({ media, onRemove }: CompactMediaPreviewProps) {
  return (
    <div className="relative bg-card border border-border rounded-[var(--radius)] overflow-hidden group">
      <div className="aspect-[9/16] max-h-[400px] bg-muted-foreground/10 flex items-center justify-center relative">
        {media.type === 'image' ? (
          <img src={media.url} alt="Upload preview" className="w-full h-full object-contain" />
        ) : (
          <video src={media.url} className="w-full h-full object-contain" muted />
        )}

        <div className="absolute top-3 left-3 bg-background/90 rounded-[var(--radius)] px-3 py-1.5 flex items-center gap-2">
          {media.type === 'image' ? <ImageIcon size={16} /> : <Video size={16} />}
          <span style={{ fontSize: '13px', fontWeight: 'var(--font-weight-medium)' }}>
            {media.type === 'image' ? 'Image' : 'Video'}
          </span>
        </div>

        <button
          onClick={onRemove}
          className="absolute top-3 right-3 bg-destructive text-destructive-foreground rounded-full p-2 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X size={18} />
        </button>

        {media.status === 'analyzing' && (
          <div className="absolute inset-0 bg-background/80 flex flex-col items-center justify-center">
            <Loader2 className="animate-spin mb-3 text-primary" size={40} />
            <span style={{ fontSize: '16px', fontWeight: 'var(--font-weight-medium)' }}>Analyzing...</span>
          </div>
        )}

        {media.status === 'rejected' && (
          <div className="absolute inset-0 bg-destructive/90 flex flex-col items-center justify-center text-destructive-foreground p-6 text-center">
            <AlertCircle size={48} className="mb-3" />
            <span style={{ fontSize: '16px', fontWeight: 'var(--font-weight-medium)' }}>Content Rejected</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AIAnalysisPanel (updated with real data + flag breakdown) ────────────────

interface AIAnalysisPanelProps {
  media: UploadedMedia;
}

const FLAG_LABELS: Record<string, string> = {
  nudity: 'Nudity / Sexual content',
  profanity: 'Profanity / Offensive text',
  violence: 'Violence / Gore',
  illegalItems: 'Drugs / Weapons / Illegal items',
  contactInfo: 'Contact information',
  offTopicContent: 'Off-topic content',
};

function AIAnalysisPanel({ media }: AIAnalysisPanelProps) {
  if (media.status === 'analyzing') {
    return (
      <div className="bg-card border border-border rounded-[var(--radius)] p-8 min-h-[400px] flex flex-col items-center justify-center">
        <Loader2 className="animate-spin mb-4 text-primary" size={48} />
        <h4 className="mb-2" style={{ fontSize: '18px', fontWeight: 'var(--font-weight-medium)' }}>
          AI Analysis in Progress
        </h4>
        <p className="text-muted-foreground text-center" style={{ fontSize: '15px', lineHeight: '1.6' }}>
          Our AI is analyzing your content to ensure it meets our guidelines and to identify the best audience for your story.
        </p>
      </div>
    );
  }

  if (media.status === 'error') {
    return (
      <div className="bg-card border border-yellow-500/50 rounded-[var(--radius)] p-8">
        <div className="flex items-start gap-4 mb-4">
          <div className="w-12 h-12 bg-yellow-500/20 rounded-full flex items-center justify-center flex-shrink-0">
            <AlertCircle size={24} className="text-yellow-600" />
          </div>
          <div>
            <h4 className="text-yellow-700 mb-1" style={{ fontSize: '20px', fontWeight: 'var(--font-weight-medium)' }}>
              Analysis Failed
            </h4>
            <p className="text-muted-foreground" style={{ fontSize: '15px', lineHeight: '1.6' }}>
              {media.error ?? 'An unexpected error occurred. Please try again.'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (media.status === 'rejected' && media.aiAnalysis) {
    const flags = media.aiAnalysis.flaggedCategories;
    const triggeredFlags = Object.entries(FLAG_LABELS).filter(([key]) => flags[key as keyof typeof flags]);

    return (
      <div className="bg-card border border-destructive/50 rounded-[var(--radius)] p-8 space-y-6">
        {/* Error Header */}
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-destructive/20 rounded-full flex items-center justify-center flex-shrink-0">
            <AlertCircle size={24} className="text-destructive" />
          </div>
          <div>
            <h4 className="text-destructive mb-1" style={{ fontSize: '20px', fontWeight: 'var(--font-weight-medium)' }}>
              Content Not Approved
            </h4>
            <p className="text-muted-foreground" style={{ fontSize: '15px', lineHeight: '1.6' }}>
              Our AI detected issues with your uploaded content.
            </p>
          </div>
        </div>

        {/* Rejection Reasons */}
        {(media.aiAnalysis.moderationReasons?.length ?? 0) > 0 && (
          <div className="bg-destructive/10 border border-destructive/30 rounded-[var(--radius-lg)] p-5">
            <h4 className="text-foreground mb-3" style={{ fontSize: '16px', fontWeight: 'var(--font-weight-medium)' }}>
              Rejection Reasons:
            </h4>
            <ul className="space-y-2">
              {media.aiAnalysis.moderationReasons!.map((reason, index) => (
                <li key={index} className="flex items-start gap-3 text-muted-foreground" style={{ fontSize: '15px', lineHeight: '1.6' }}>
                  <span className="text-destructive mt-1" style={{ fontSize: '18px' }}>•</span>
                  <span>{reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Flagged Categories */}
        {triggeredFlags.length > 0 && (
          <div className="bg-card border border-border rounded-[var(--radius)] p-5">
            <div className="text-muted-foreground mb-3" style={{ fontSize: '12px', fontWeight: 'var(--font-weight-medium)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Flagged Categories
            </div>
            <div className="divide-y divide-border">
              {triggeredFlags.map(([key, label]) => (
                <div key={key} className="flex items-center justify-between py-2.5">
                  <span style={{ fontSize: '14px' }}>{label}</span>
                  <span className="bg-destructive/15 text-destructive rounded-full px-2.5 py-0.5" style={{ fontSize: '11px', fontWeight: 'var(--font-weight-medium)' }}>
                    Flagged
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-muted/50 rounded-[var(--radius)] p-5">
          <p className="text-foreground" style={{ fontSize: '15px', lineHeight: '1.6' }}>
            Please remove this content and upload a different picture or video that meets our guidelines.
          </p>
        </div>
      </div>
    );
  }

  if (media.status === 'approved' && media.aiAnalysis) {
    const flags = media.aiAnalysis.flaggedCategories;
    const confidencePct = Math.round(media.aiAnalysis.confidence * 100);

    return (
      <div className="bg-card border border-border rounded-[var(--radius)] p-8 space-y-6">
        {/* Success Header */}
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 bg-chart-2/20 rounded-full flex items-center justify-center flex-shrink-0">
            <CheckCircle2 size={24} className="text-chart-2" />
          </div>
          <div>
            <h4 className="text-chart-2 mb-1" style={{ fontSize: '20px', fontWeight: 'var(--font-weight-medium)' }}>
              Content Approved
            </h4>
            <p className="text-muted-foreground" style={{ fontSize: '15px', lineHeight: '1.6' }}>
              Your content passed all our checks and is ready to publish!
            </p>
          </div>
        </div>

        {/* Content Type */}
        <div>
          <div className="text-muted-foreground mb-2" style={{ fontSize: '12px', fontWeight: 'var(--font-weight-medium)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Content Type Detected
          </div>
          <div className="bg-primary/10 border border-primary/20 rounded-[var(--radius)] px-4 py-3">
            <span className="text-primary" style={{ fontSize: '16px', fontWeight: 'var(--font-weight-medium)' }}>
              {media.aiAnalysis.contentType[0]}
            </span>
          </div>
        </div>

        {/* Tags */}
        <div>
          <div className="text-muted-foreground mb-2" style={{ fontSize: '12px', fontWeight: 'var(--font-weight-medium)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            AI-Generated Tags
          </div>
          <div className="flex flex-wrap gap-2">
            {media.aiAnalysis.tags.map((tag, i) => (
              <span
                key={i}
                className="bg-muted text-foreground px-3 py-2 rounded-[var(--radius)]"
                style={{ fontSize: '14px', fontWeight: 'var(--font-weight-medium)' }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* Confidence Score */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-muted-foreground" style={{ fontSize: '12px', fontWeight: 'var(--font-weight-medium)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Model Confidence
            </div>
            <span className="text-chart-2" style={{ fontSize: '14px', fontWeight: 'var(--font-weight-medium)' }}>
              {confidencePct}%
            </span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-chart-2 rounded-full transition-all duration-700"
              style={{ width: `${confidencePct}%` }}
            />
          </div>
        </div>

        {/* Moderation Checks */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Shield size={14} className="text-muted-foreground" />
            <div className="text-muted-foreground" style={{ fontSize: '12px', fontWeight: 'var(--font-weight-medium)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Moderation Checks
            </div>
          </div>
          <div className="bg-card border border-border rounded-[var(--radius)] divide-y divide-border">
            {Object.entries(FLAG_LABELS).map(([key, label]) => {
              const flagged = flags[key as keyof typeof flags];
              return (
                <div key={key} className="flex items-center justify-between px-4 py-2.5">
                  <span style={{ fontSize: '14px' }}>{label}</span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 ${flagged ? 'bg-destructive/15 text-destructive' : 'bg-chart-2/15 text-chart-2'}`}
                    style={{ fontSize: '11px', fontWeight: 'var(--font-weight-medium)' }}
                  >
                    {flagged ? 'Flagged' : 'Clear'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return null;
}
