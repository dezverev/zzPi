export interface BrainstormSolution {
  readonly approach: string;
  readonly cons: readonly string[];
  readonly nextSteps: readonly string[];
  readonly pros: readonly string[];
  readonly repoTouchpoints: readonly string[];
  readonly risks: readonly string[];
  readonly title: string;
  readonly unknowns: readonly string[];
}

export type BrainstormerDecision =
  | {
      readonly kind: "brainstorm";
      readonly questions?: readonly string[] | undefined;
      readonly recommendedSolutionTitle?: string | undefined;
      readonly solutions: readonly BrainstormSolution[];
      readonly summary?: string | undefined;
    }
  | {
      readonly kind: "questions";
      readonly questions: readonly string[];
      readonly summary?: string | undefined;
    };

export interface DesignPlanStep {
  readonly details: string;
  readonly risks: readonly string[];
  readonly title: string;
  readonly touchpoints: readonly string[];
  readonly validation: readonly string[];
}

export type DesignplannerDecision =
  | {
      readonly acceptanceCriteria: readonly string[];
      readonly architecture: string;
      readonly handoffPrompt?: string | undefined;
      readonly kind: "design_plan";
      readonly objective: string;
      readonly questions?: readonly string[] | undefined;
      readonly risks: readonly string[];
      readonly selectedSolutionTitle: string;
      readonly steps: readonly DesignPlanStep[];
      readonly summary?: string | undefined;
      readonly unknowns: readonly string[];
      readonly validation: readonly string[];
    }
  | {
      readonly kind: "questions";
      readonly questions: readonly string[];
      readonly summary?: string | undefined;
    };
