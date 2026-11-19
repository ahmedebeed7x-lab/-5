import React, { useCallback, useEffect, useRef, useState } from 'react';

export type TeacherDrawTool = 'cursor' | 'pen' | 'highlighter' | 'laser' | 'eraser';

export interface TeacherPoint {
  x: number;
  y: number;
}

export interface TeacherStroke {
  id: string;
  kind: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: TeacherPoint[];
}

interface MushafTeacherOverlayProps {
  activeTool: TeacherDrawTool;
  penColor: string;
  strokes: TeacherStroke[];
  onAddStroke: (stroke: TeacherStroke) => void;
  onRemoveStroke: (strokeId: string) => void;
}

function buildSmoothPath(points: TeacherPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} L ${(p.x + 0.1).toFixed(1)} ${(p.y + 0.1).toFixed(1)}`;
  }
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)} L ${points[1].x.toFixed(1)} ${points[1].y.toFixed(1)}`;
  }
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x.toFixed(1)} ${points[i].y.toFixed(1)} ${midX.toFixed(1)} ${midY.toFixed(1)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}

function distanceToSegmentSq(p: TeacherPoint, a: TeacherPoint, b: TeacherPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const px = p.x - a.x;
    const py = p.y - a.y;
    return px * px + py * py;
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  const rx = p.x - projX;
  const ry = p.y - projY;
  return rx * rx + ry * ry;
}

function hitsStroke(point: TeacherPoint, stroke: TeacherStroke, radius: number): boolean {
  const rSq = radius * radius;
  const pts = stroke.points;
  if (pts.length === 0) return false;
  if (pts.length === 1) {
    const dx = point.x - pts[0].x;
    const dy = point.y - pts[0].y;
    return dx * dx + dy * dy <= rSq;
  }
  for (let i = 0; i < pts.length - 1; i++) {
    if (distanceToSegmentSq(point, pts[i], pts[i + 1]) <= rSq) {
      return true;
    }
  }
  return false;
}

export const MushafTeacherOverlay: React.FC<MushafTeacherOverlayProps> = ({
  activeTool,
  penColor,
  strokes,
  onAddStroke,
  onRemoveStroke,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const laserFadeTimerRef = useRef<number | null>(null);
  const [draftStroke, setDraftStroke] = useState<TeacherStroke | null>(null);
  const [laserTrail, setLaserTrail] = useState<TeacherPoint[]>([]);
  const [laserHead, setLaserHead] = useState<TeacherPoint | null>(null);

  const isInteractive = activeTool !== 'cursor';

  useEffect(() => {
    setDraftStroke(null);
    activePointerIdRef.current = null;
    if (activeTool !== 'laser') {
      setLaserHead(null);
      setLaserTrail([]);
    }
  }, [activeTool]);

  useEffect(() => {
    return () => {
      if (laserFadeTimerRef.current) {
        window.clearTimeout(laserFadeTimerRef.current);
      }
    };
  }, []);

  const toNormalizedPoint = useCallback((clientX: number, clientY: number): TeacherPoint | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.max(0, Math.min(1000, ((clientX - rect.left) / rect.width) * 1000)),
      y: Math.max(0, Math.min(1000, ((clientY - rect.top) / rect.height) * 1000)),
    };
  }, []);

  const eraseNearPoint = useCallback(
    (pt: TeacherPoint) => {
      const hitRadius = 18;
      for (const st of strokes) {
        if (hitsStroke(pt, st, hitRadius)) {
          onRemoveStroke(st.id);
        }
      }
    },
    [strokes, onRemoveStroke]
  );

  const scheduleLaserFade = useCallback(() => {
    if (laserFadeTimerRef.current) {
      window.clearTimeout(laserFadeTimerRef.current);
    }
    laserFadeTimerRef.current = window.setTimeout(() => {
      setLaserTrail([]);
    }, 550);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isInteractive) return;
    const pt = toNormalizedPoint(e.clientX, e.clientY);
    if (!pt) return;

    if (activeTool === 'laser') {
      setLaserHead(pt);
      setLaserTrail((prev) => [...prev.slice(-14), pt]);
      scheduleLaserFade();
      return;
    }

    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointerIdRef.current = e.pointerId;

    if (activeTool === 'eraser') {
      eraseNearPoint(pt);
      return;
    }

    const kind = activeTool === 'highlighter' ? 'highlighter' : 'pen';
    setDraftStroke({
      id: `st_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      kind,
      color: penColor,
      width: kind === 'highlighter' ? 20 : 3.2,
      points: [pt],
    });
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isInteractive) return;
    const pt = toNormalizedPoint(e.clientX, e.clientY);
    if (!pt) return;

    if (activeTool === 'laser') {
      setLaserHead(pt);
      setLaserTrail((prev) => {
        const last = prev[prev.length - 1];
        if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 3) return prev;
        return [...prev.slice(-16), pt];
      });
      scheduleLaserFade();
      return;
    }

    if (activePointerIdRef.current !== e.pointerId) return;

    if (activeTool === 'eraser') {
      eraseNearPoint(pt);
      return;
    }

    setDraftStroke((prev) => {
      if (!prev) return prev;
      const last = prev.points[prev.points.length - 1];
      if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 2) {
        return prev;
      }
      return {
        ...prev,
        points: [...prev.points, pt],
      };
    });
  };

  const commitDraftStroke = (e: React.PointerEvent<SVGSVGElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore if pointer capture already released
    }

    if (draftStroke && draftStroke.points.length > 0) {
      onAddStroke(draftStroke);
    }
    setDraftStroke(null);
  };

  const handlePointerLeave = () => {
    if (activeTool === 'laser') {
      setLaserHead(null);
      scheduleLaserFade();
    }
  };

  const renderStrokes = draftStroke ? [...strokes, draftStroke] : strokes;

  return (
    <svg
      ref={svgRef}
      className={`mushaf-teacher-overlay is-tool-${activeTool}`}
      viewBox="0 0 1000 1000"
      preserveAspectRatio="none"
      aria-hidden="true"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={commitDraftStroke}
      onPointerCancel={commitDraftStroke}
      onPointerLeave={handlePointerLeave}
    >
      {renderStrokes.map((st) => (
        <path
          key={st.id}
          d={buildSmoothPath(st.points)}
          fill="none"
          stroke={st.color}
          strokeWidth={st.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity={st.kind === 'highlighter' ? 0.28 : 0.9}
          vectorEffect="non-scaling-stroke"
          style={st.kind === 'highlighter' ? { mixBlendMode: 'multiply' } : undefined}
        />
      ))}

      {activeTool === 'laser' && laserTrail.length > 1 && (
        <path
          d={buildSmoothPath(laserTrail)}
          fill="none"
          stroke="#EF4444"
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity={0.34}
          vectorEffect="non-scaling-stroke"
        />
      )}

      {activeTool === 'laser' && laserHead && (
        <g transform={`translate(${laserHead.x.toFixed(1)}, ${laserHead.y.toFixed(1)})`}>
          <ellipse rx="14" ry="11" fill="rgba(239, 68, 68, 0.22)" />
          <ellipse rx="6" ry="4.6" fill="#EF4444" stroke="#FFFFFF" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </g>
      )}
    </svg>
  );
};
