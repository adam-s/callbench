export {
	type Assertion,
	askedBeforeQuoting,
	CLARITY_FLOOR,
	correctionPropagated,
	noFabricatedRecalibration,
	runAssertions,
} from './assertions.ts';
export {
	fail,
	inconclusive,
	type Outcome,
	pass,
	type Result,
	type Span,
} from './outcome.ts';
export { buildReport, type Report, renderReport } from './report.ts';
