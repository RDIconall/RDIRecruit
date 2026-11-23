-- The method doc seeded by 20260824221348_dynamic_seat_evaluation.sql asks the
-- grader for an "approximate maturation placement" (an inferred age). Age must
-- never be estimated or used, so rewrite those two sentences in place on any
-- method version that still carries them verbatim. Versions edited in-app no
-- longer match and are left alone; the evaluator's output contract forbids age
-- estimates regardless of the method text.

update public.calibration
   set markdown = replace(
         replace(
           markdown,
           'Preserve Requisite Organization analysis: chronology, first professional role, undergraduate graduation where relevant, career span, progression rate, time-span of discretion, RO strata, and approximate maturation placement.',
           'Preserve Requisite Organization analysis: chronology, first professional role, career span, progression rate, time-span of discretion, and RO strata.'
         ),
         'Approximate age/maturation placement must not directly add/subtract seat-fit points, trigger interview/pass thresholds, sort candidates, change salary recommendations, or trigger alternate-seat recommendations.',
         'Never estimate, infer, or state age or an age-based maturation placement. Career span in years is the only time signal and must not directly add/subtract seat-fit points, trigger interview/pass thresholds, sort candidates, change salary recommendations, or trigger alternate-seat recommendations.'
       )
 where scope = '__method__'
   and markdown like '%approximate maturation placement%';
