export interface PlanLimits {
  monthlyApprovals: number | null;
  maxProjects: number | null;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { monthlyApprovals: 300, maxProjects: 1 },
  pro: { monthlyApprovals: 5000, maxProjects: 10 },
  agency: { monthlyApprovals: 25000, maxProjects: null },
  enterprise: { monthlyApprovals: null, maxProjects: null },
};

export function getPlanLimits(plan: string | null | undefined): PlanLimits {
  return PLAN_LIMITS[plan ?? 'free'] ?? PLAN_LIMITS.free;
}
