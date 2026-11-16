// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { createPrimeAgentSkillSubject } from "./prime-agent-subject.ts";
import { registerConformance } from "./suite.ts";

registerConformance(createPrimeAgentSkillSubject());
