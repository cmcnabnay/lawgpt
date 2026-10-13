# Answer Key — Engineering-Flavored CivPro Practice Set

Based on Practice Midterms 1–3 (Lanham, Fall 2025). Each answer notes which midterm question it mirrors.

---

## 1. Pipeline plausibility (mirrors PM2 Q4, PM3 Q1)

**Math:** 2St/D = 2(52,000)(0.375)/24 = **1,625 psig**. MAOP = 1,625 × 0.72 = **1,170 psig**.

- **(a) Version A (1,250 psig): Likely survives.** Under Twombly/Iqbal, take well-pleaded *facts* as true. The SCADA reading (1,250) > MAOP (1,170) by 80 psig (~6.8%). That factual allegation, plus the rupture, makes it plausible the statute was violated. Disregard the conclusory "knowingly and recklessly" line. It's a legal label, and the statute doesn't require knowledge anyway.
- **(b) Version B (1,100 psig): Likely dismissed under 12(b)(6).** Taking the plaintiff's own number as true, the pipe ran 70 psig *below* MAOP. The only remaining allegation of overpressure is the conclusory "on information and belief, Defendant exceeded MAOP," which is disregarded. The remaining facts don't plausibly show an element of the claim. (Dismissal is often with leave to amend.)
- **Takeaway:** at the pleading stage the math is done *on the plaintiff's own numbers*. The court isn't deciding whose gauge is right. That's for later.

## 2. Bridge firm deadlines (mirrors PM1 Q1–2, PM2 Q8, Q10)

- **(a)** 21 days after service (Rule 12(a)(1)(A)(i)): Mar 2 + 21 = **Mon, Mar 23, 2026**. The Mar 13 motion is timely (a 12(b) motion must be made before the responsive pleading; 12(b)).
- **(b)** Rule 12(a)(4)(A): 14 days after notice of denial: Apr 24 + 14 = **Fri, May 8, 2026**. An answer served May 15 is **late** (7 days).
- **(c)** Answer actually served May 8. Rule 15(a)(1)(A): amend once as a matter of course within 21 days after serving → **Fri, May 29, 2026**. May 27 is within the window → **just amend as of course**; no leave or consent needed.
- **(d)** June 10 is past May 29, so no amendment as of course. And it can't file a 12(b)(6) after answering. But failure to state a claim is preserved by **Rule 12(h)(2)**, so it files a **12(c) motion for judgment on the pleadings**. (Exactly PM1 Q2 → D.) It could also seek leave to amend under 15(a)(2), but 12(c) is the direct route for this argument.

## 3. Service by the intern (mirrors PM2 Q3)

- **(a)** Born Jul 15, 2008; served Apr 10, 2026 → **17 years old**.
- **(b) Grant the 12(b)(5) motion.** Rule 4(c)(2): server must be **at least 18** and not a party. Leaving it with the 16-year-old resident daughter at the dwelling is probably fine under 4(e)(2)(B) ("suitable age and discretion who resides there"; a 16-year-old is a much better case than PM2's 5-year-old), but the server's age is an independent defect. Actual notice doesn't cure a Rule 4 violation.
- **(c)** Rule 4(m): 90 days after the complaint is filed: Jan 20 + 90 = **Mon, Apr 20, 2026**. Re-serve with an adult (or request a 4(d) waiver) before then; if they miss it, the court must extend on good cause and may extend anyway.

## 4. Balcony data logger (mirrors PM2 Q6)

**Math:** 5,616 samples × 10 min = 56,160 min = 936 h = **39.0 days** → Jan 1, 2024 00:00 + 39 days = **Fri, Feb 9, 2024, 00:00**. Two-year deadline: **Mon, Feb 9, 2026**. Filed Feb 10, 2026 → **one day late**.

- **(a) Grant SJ for Defendant.** Defendant carries its burden on the affirmative defense with evidence (the log). Plaintiff offered nothing to contradict it. No genuine dispute → time-barred. (Same structure as PM2 Q6 → D.)
- **(b) Deny SJ.** Plaintiff's sworn testimony of Feb 14, 2024 would make the suit timely (deadline then = Feb 16, 2026, since Feb 14, 2026 is a Saturday, though Feb 14 alone is already after the 10th). Credibility of the testimony against the logger is for the jury (Tolan). Viewing the evidence in Plaintiff's favor, a reasonable jury could find the collapse happened Feb 14.
- **(c) Grant SJ.** "Sometime in February 2024" doesn't contradict Feb 9, so there's no *genuine* dispute. Vague testimony that fits the movant's evidence doesn't create one.

## 5. Wind turbine fragment (mirrors PM1 Q5, PM3 essay; Tolan)

**Math:** ω = 15 rpm = 1.571 rad/s; v_tip = ωr = 1.571 × 60 = **94.2 m/s**.
Flat-ground vacuum max range v²/g = **905 m**. From 100 m hub height: R = (v/g)√(v² + 2gh) = **≈1,000 m**. That's an absolute upper bound, since drag only shortens the throw.

- **(a) Barn at 450 m: Deny SJ.** 450 m is physically possible (< 1,000 m). Defendant's expert says 300 m and Plaintiff's says 600 m. That's a battle of experts, and choosing between them is weighing credibility, which the court can't do at SJ. View the evidence in Plaintiff's favor: a reasonable jury could credit the 600 m model and find causation.
- **(b) Barn at 1,500 m: Grant SJ.** Even the most generous physics (no drag, optimal angle, launch from hub height) caps the throw at ~1,000 m, so 1,500 m is ~50% beyond the ceiling. The neighbor's "I think it came from there" is speculation that's contradicted by undisputed physics, so no reasonable jury could find causation. (Analogy: Scott v. Harris, where testimony blatantly contradicted by the record doesn't create a genuine dispute.)

## 6. Jury attrition (mirrors PM2 Q2)

**Math:** p(juror survives 3 weeks) = 0.96³ = **0.8847**.
P(≥6 of n remain) = Σ_{k=6..n} C(n,k) p^k (1−p)^(n−k):

| seated n | P(≥6 remain) |
|---|---|
| 6 | 47.96% |
| 7 | 81.13% |
| 8 | **94.51%** |
| 9 | 98.62% |
| 10 | **99.69%** |

- **(a)** 8 seated → **≈94.5%**.
- **(b)** Smallest n with ≥99% → **10** (9 gives only 98.6%). Rule 48(a) allows up to 12.
- **(c) Verdict invalid.** 11 jurors is fine (≥6), but Rule 48(b) requires a **unanimous** verdict unless the parties stipulate otherwise. 9–2 without a stipulation → no valid verdict. (The 7th Amendment doesn't require 12 jurors.)

## 7. Drone vs. solar farm, jury right (mirrors PM2 Q9, PM3 Q6)

**Math:** Panels 40 × $310 = $12,400; labor 12 × $95 = $1,140; lost generation 40 × 0.4 kW × 5 h/day × 60 days = **4,800 kWh** × $0.15 = $720. **Total damages = $14,260.**

- **(a)** Jury right on the **damages claim**. Two-prong test: (1) historical analogue is trespass/negligence to property, a common-law tort; (2) the remedy, compensatory money damages, is legal, and that prong matters most. The new statute doesn't defeat the right.
- **(b)** The **injunction (geofence)** is equitable → decided by the judge. Because the claims share fact issues (did the drone cause the damage?), the jury decides those common facts first and the judge is bound by them (Beacon Theatres / Dairy Queen), if covered in your course.
- The whole $14,260 is legal relief, *including* the lost-generation component (it's consequential damages, not disgorgement of the defendant's profits).

## 8. E-discovery clawback (mirrors PM1 Q4, PM3 Q3; FRE 502(b))

**Math:** Firm A expected leaks = 3,000 × (1 − 0.98) = **60 docs** = 60/250,000 = **0.024%** of the production.

- **(a) Firm A: no waiver; clawback.** FRE 502(b): (1) inadvertent; (2) reasonable steps to prevent (privilege screen with 98% recall + attorney QC sampling, which is solid for 250k docs); (3) promptly rectified (notice 2 days after learning, following Rule 26(b)(5)(B)). Opponent must return/sequester; it can't keep using them.
- **(b) Firm B: likely waived.** With no screen, *all* 3,000 privileged docs go out (100% leak rate), and notifying 5 months later is neither "reasonable steps to prevent" nor "prompt." Same lesson as PM1 Q4 (memo dropped on the pile).

## 9. Crane collapse report (mirrors PM1 Q3, PM3 Q4)

**Math:** Load moment = 18,000 kg × 25 m = **450 t·m**. Rated at 25 m = 16,000 kg → 400 t·m. Load was **112.5%** of rated capacity (12.5% overload).

- **(a)** The report is **work product**, because it was prepared in anticipation of litigation (commissioned by counsel 2 days after a fatal collapse). In-house counsel is fine (PM3 Q4 → A); the parallel regulatory filing doesn't strip protection from a separate litigation-driven report.
- **(b)** The **factual measurements** (boom angle, radius, load weight) are fact work product, obtainable on **substantial need + inability to get the substantial equivalent without undue hardship** (26(b)(3)(A)(ii)). The crane was **scrapped 3 days after**, so Plaintiff can't re-measure, which is the twist PM1 Q3 flagged ("unless something happened to the slide"). → Likely discoverable.
- **(c)** Counsel's margin notes on litigation strategy = **opinion work product**, protected near-absolutely (26(b)(3)(B)); redact.
- **(d)** Underlying **facts** are never shielded by work product: Plaintiff can ask the site superintendent in deposition what the load weighed. (If the engineer is a non-testifying consulting expert, 26(b)(4)(D) limits deposing *the engineer* absent exceptional circumstances. The scrapped crane is a strong argument for exceptional circumstances.)

## 10. Firmware source-code order and appeal (mirrors PM1 essay, PM2 Q7)

**Dates:** Order entered Fri, Jun 5, 2026.
- **(a)** §1292(b) petition: 10 days → **Mon, Jun 15, 2026**, and only if the district judge certifies the order.
- **(b)** Notice of appeal (FRAP 4(a)(1)(A)): 30 days → Sun, Jul 5 → rolls to **Mon, Jul 6, 2026** (FRAP 26(a)(1)(C)). If the U.S. is a party: 60 days → **Tue, Aug 4, 2026**.
- **(c) Likely appealable under the collateral order doctrine** (same structure as the Navy essay): (1) **conclusive**, because once source code is filed unsealed it can't be re-decided; (2) **important and separate**, because trade-secret confidentiality is distinct from the merits (did the inverter shut down?); (3) **effectively unreviewable after final judgment**, because you can't un-ring the bell once the code is public. **Counter (Mohawk):** discovery orders generally aren't collateral orders, and alternatives exist (1292(b), mandamus, contempt). Either conclusion scores if reasoned.

## 11. Easement notice by newspaper (mirrors PM2 essay; Mullane, Jones v. Flowers)

**Math:** Newspaper reach = 2,000 / 80,000 = **2.5%** of the county. Certified mail to all 3 owners = 3 × $8.50 = **$25.50**. The easements are worth ~$140,000.

- **Publication alone is insufficient** for owners whose names and addresses are known (Mullane). Notice must be *reasonably calculated* to inform, and a 2.5%-reach paper is the opposite. A trivially cheap, superior alternative existed ($25.50 versus a $140k property interest).
- **Owner whose certified letter came back unclaimed:** once the sender knows notice failed, it must take further reasonable steps if feasible (Jones v. Flowers), such as regular mail, posting at the property, or personal service.
- **Owner who called the utility to complain:** has actual notice, which is sufficient (like Cora in PM2).

## 12. Telemetry discovery and proportionality (mirrors PM2 Q5)

**Math:** 4 TB / 2 MB per file = **2,000,000 files**; at 50 files/hr → **40,000 hours**; × $60 = **$2,400,000**, which is **26.7×** the $90,000 in controversy. Narrowed (Plaintiff's 120 units): 1,800 files → 36 h → **$2,160**.

- **Telemetry:** object on **proportionality** (26(b)(1): amount in controversy, burden versus benefit, importance) and/or seek a protective order (26(c)(1)) limiting scope to Plaintiff's units. Relevance alone won't work. Fleet-wide data has *some* relevance (a pattern of defects), so lead with proportionality.
- **Source code:** it's a trade secret but relevant, so it's **not** privileged or work product (PM2 Q5 → C). The right move is a **26(c)(1)(G) protective order** (attorneys'-eyes-only, secure review room, no copies).

---

## Essay: Benzene exposure, summary judgment (mirrors PM3 essay, PM1 Q5)

**Math:**
- TWA = (2·0.5 + 3·1.8 + 3·0.9)/8 = (1.0 + 5.4 + 2.7)/8 = 9.1/8 = **1.1375 ppm** > 1.0 PEL.
- ±15% pump accuracy → range **0.967 to 1.308 ppm**. The lower bound dips below the PEL.
- Concentration needed in the 9–12 window for TWA = exactly 1.0: (8 − 1.0 − 2.7)/3 = **1.433 ppm**. The measured 1.8 exceeds that by ~26%, more than the 15% error band. So even if *only* the high-reading window were biased high by the full 15% (1.53 ppm), the TWA would still exceed the PEL (≈1.04). (Strong point for Raj.)
- Company 24-sample average 0.6 ppm doesn't negate exceedance on a *specific* day; an average can hide peaks.

**IRAC sketch:**
- **Issue:** Is there a genuine dispute of material fact on any element, viewing the evidence in Raj's favor?
- **Rule:** Rule 56(a). No genuine dispute of material fact + movant entitled to judgment as a matter of law. Evidence viewed in the light most favorable to the nonmovant; the court doesn't weigh credibility (Tolan). Start from the substantive elements (Lanham's note on PM3).
- **(a) Illness:** undisputed (AML diagnosis).
- **(c) Damages:** $212,400 receipts. Undisputed that damages exist; the exact amount is for the jury.
- **(b) Exposure above PEL + causation: the close call.**
  - *Exposure:* The company's own badge data yields 1.14 ppm. A reasonable jury could credit the measurement. Defendant's ±15% and annual-average arguments go to *weight*, not admissibility or genuineness. → Genuine dispute.
  - *Causation:* Unlike PM3's doctor (who disavowed causation and admitted bias), Dr. Okafor says AML is "consistent with" benzene exposure and Raj has no other known risk factors. A jury could reasonably infer causation, though "consistent with" alone is weak. Defendant will say a single-day exceedance can't cause leukemia; that is an expert dispute for trial unless Defendant offers undisputed evidence otherwise (it didn't).
- **Conclusion:** Deny SJ. A grader would also credit a well-reasoned grant on causation, if it explains why "consistent with" + no other risk factors can't support a reasonable inference.
