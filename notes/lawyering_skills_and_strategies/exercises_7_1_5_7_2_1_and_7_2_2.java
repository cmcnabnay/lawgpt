import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class exercises_7_1_5_7_2_1_and_7_2_2 {
    public static void main(String[] args) {
        new DocumentCompilerFacade().execute();
    }
}

final class CodePointRepository {
    private static final String TEXT =
        "\u001b[0m\u001b[1mExercise 7.1.5: Crafting a Rule from a Series of Cases\u001b[0m\n"
        + "\u001b[0m\u001b[1mNote on missing material:\u001b[0m The attached exercise document\n"
        + "includes only one of the four case summaries referenced (\"read\n"
        + "the following four case summaries\") \u2014 *Goddard v. Boston & M. R.\n"
        + "R. Co.* The summaries for the other three cases, and the blank\n"
        + "rule-synthesis chart itself, are not present in the file\n"
        + "provided. I can't complete the chart or synthesize a rule across\n"
        + "four cases without inventing case facts I don't actually have.\n"
        + "Below is the rule that can be drawn from Goddard alone; the\n"
        + "synthesized rule would need to account for the other three cases\n"
        + "once they're available.\n"
        + "\u001b[0m\u001b[1mRule-synthesis chart (partial \u2014 1 of 4 cases available):\u001b[0m\n"
        + "+--------------+--------------+--------------+--------------+\n"
        + "| \u001b[0m\u001b[1mCase\u001b[0m         | \u001b[0m\u001b[1mKey Facts\u001b[0m    | \u001b[0m\u001b[1mHolding\u001b[0m      | \u001b[0m\u001b[1mPrinciple/Ru\u001b[0m |\n"
        + "|              |              |              | \u001b[0m\u001b[1mle Extracted\u001b[0m |\n"
        + "+--------------+--------------+--------------+--------------+\n"
        + "| *Goddard v.  | Plaintiff    | Plaintiff    | A            |\n"
        + "| Boston & M.  | slipped on a | could not    | landowner/oc |\n"
        + "| R. R. Co.*,  | banana peel  | recover.     | cupier is    |\n"
        + "| 60 N.E. 486  | on a train   |              | not liable   |\n"
        + "| (Mass. 1901) | station      |              | for a        |\n"
        + "|              | platform     |              | slipping     |\n"
        + "|              | with many    |              | hazard left  |\n"
        + "|              | passengers   |              | by a third   |\n"
        + "|              | passing      |              | party unless |\n"
        + "|              | through; no  |              | the          |\n"
        + "|              | evidence of  |              | plaintiff    |\n"
        + "|              | how long the |              | produces     |\n"
        + "|              | peel had     |              | evidence of  |\n"
        + "|              | been there   |              | how long the |\n"
        + "|              | before the   |              | hazard was   |\n"
        + "|              | fall.        |              | present \u2014    |\n"
        + "|              |              |              | i.e.,        |\n"
        + "|              |              |              | evidence     |\n"
        + "|              |              |              | sufficient   |\n"
        + "|              |              |              | to show the  |\n"
        + "|              |              |              | defendant    |\n"
        + "|              |              |              | had (or      |\n"
        + "|              |              |              | should have  |\n"
        + "|              |              |              | had) notice  |\n"
        + "|              |              |              | of the       |\n"
        + "|              |              |              | hazard in    |\n"
        + "|              |              |              | time to      |\n"
        + "|              |              |              | remove it.   |\n"
        + "+--------------+--------------+--------------+--------------+\n"
        + "| Case 2       | *not         | \u2014            | \u2014            |\n"
        + "|              | provided in  |              |              |\n"
        + "|              | attached     |              |              |\n"
        + "|              | document*    |              |              |\n"
        + "+--------------+--------------+--------------+--------------+\n"
        + "| Case 3       | *not         | \u2014            | \u2014            |\n"
        + "|              | provided in  |              |              |\n"
        + "|              | attached     |              |              |\n"
        + "|              | document*    |              |              |\n"
        + "+--------------+--------------+--------------+--------------+\n"
        + "| Case 4       | *not         | \u2014            | \u2014            |\n"
        + "|              | provided in  |              |              |\n"
        + "|              | attached     |              |              |\n"
        + "|              | document*    |              |              |\n"
        + "+--------------+--------------+--------------+--------------+\n"
        + "\n"
        + "\u001b[0m\u001b[1mWhat is the rule from *Goddard v. Boston*?\u001b[0m\n"
        + "A plaintiff cannot recover for a slip-and-fall caused by a\n"
        + "foreign substance (here, a banana peel) left on a defendant's\n"
        + "premises by a third party unless the plaintiff comes forward\n"
        + "with evidence establishing how long the substance had been on\n"
        + "the ground. Because the mere presence of the hazard, standing\n"
        + "alone, does not show the defendant had actual or constructive\n"
        + "notice of it, the plaintiff bears the burden of producing some\n"
        + "evidence of duration (e.g., the condition of the object itself,\n"
        + "testimony about inspection or cleaning intervals) from which a\n"
        + "factfinder could infer the defendant had a reasonable\n"
        + "opportunity to discover and remove the hazard before the injury\n"
        + "occurred. Without that evidence, the claim fails as a matter of\n"
        + "law, regardless of how many people were on the premises or how\n"
        + "obviously hazardous the substance was.\n"
        + "*(A full synthesized rule governing Suzy's claim \u2014 which would\n"
        + "ordinarily draw a duration/notice threshold from comparing what\n"
        + "evidence was sufficient in the recovering cases against what was\n"
        + "insufficient in Goddard \u2014 cannot be completed until the\n"
        + "summaries for the remaining three cases are supplied.)*\n"
        + "\n"
        + "\u001b[0m\u001b[1mExercise 7.2.1: Identifying the Parts of a Case Illustration\u001b[0m\n"
        + "\u001b[0m\u001b[1mQuestion 1: Were both case illustrations complete? If not,\u001b[0m\n"
        + "\u001b[0m\u001b[1midentify what was missing in each and how the missing parts\u001b[0m\n"
        + "\u001b[0m\u001b[1mmight affect a reader's understanding.\u001b[0m\n"
        + "Neither illustration is fully complete against the five required\n"
        + "parts (hook, facts, holding, reasoning, transition).\n"
        + "*Sheirod illustration* \u2014 It has facts (residence vacant a year,\n"
        + "furnished, utilities operable), a three-factor test, a holding\n"
        + "(dwelling, \"temporary absence\"), and reasoning (suitable for\n"
        + "\"overnight accommodations\"). What it lacks is an opening \u001b[0m\u001b[1mhook\u001b[0m: a\n"
        + "topic sentence stating the legal proposition the case stands for\n"
        + "*before* diving into the facts. The paragraph opens with \"In\n"
        + "Sheirod, a private residence was vacant for a year...\" \u2014 pure\n"
        + "narrative \u2014 rather than something like \"A structure does not\n"
        + "lose its status as a dwelling merely because it sits temporarily\n"
        + "unoccupied, so long as it remains suitable for overnight\n"
        + "habitation.\" Without that framing sentence, the reader has to\n"
        + "read through the entire fact recitation before learning why the\n"
        + "case is being cited at all, which slows comprehension and forces\n"
        + "the reader to reconstruct the relevance retroactively.\n"
        + "*Quattlebaum illustration* \u2014 It has a transition (\"In\n"
        + "contrast\"), facts (school, fifth-floor offices, bed and chair,\n"
        + "occasional overnight stay), and a holding (not a dwelling). What\n"
        + "it's missing is developed \u001b[0m\u001b[1mreasoning\u001b[0m that actually applies the\n"
        + "Sheirod factors to these facts. The sentence \"The Court\n"
        + "considered the Sheirod factors and the nature of how the\n"
        + "structure was 'usually occupied'\" *names* the factors instead of\n"
        + "*applying* them \u2014 it never explains, for instance, whether there\n"
        + "was any \"intent to return\" analysis for a school, or why an\n"
        + "occasional overnight stay on the office bed didn't satisfy the\n"
        + "\"could have been occupied overnight\" factor the way the vacant\n"
        + "house did in Sheirod. The final quote (\"customary indicia of a\n"
        + "residence\") is dropped in without connecting it back to specific\n"
        + "facts (no kitchen, no permanent residents, use limited to work\n"
        + "hours, etc.). Because the reasoning is conclusory, the reader\n"
        + "cannot see *why* a bed and chair used for occasional overnight\n"
        + "stays fails the test that a furnished, utility-equipped,\n"
        + "unoccupied house passes \u2014 which is precisely the comparison a\n"
        + "reader needs in order to apply either case to a new set of facts\n"
        + "(like the treehouse).\n"
        + "\u001b[0m\u001b[1mQuestion 2: What does the transition \"in contrast\" signify? Was\u001b[0m\n"
        + "\u001b[0m\u001b[1mthe hook in the second case illustration effective?\u001b[0m\n"
        + "\"In contrast\" signals to the reader that the case about to be\n"
        + "discussed reaches the *opposite* result from the case just\n"
        + "discussed \u2014 it primes the reader to expect a distinguishing fact\n"
        + "pattern and a different outcome on the \"dwelling\" question,\n"
        + "which is useful for orienting the reader within the\n"
        + "rule-synthesis structure (one case marking one end of the\n"
        + "spectrum, the next marking the other).\n"
        + "The \"hook\" in the second illustration \u2014 effectively just \"in\n"
        + "contrast, in Quattlebaum, the Court came to the opposite\n"
        + "conclusion\" \u2014 is not effective as a hook. A good hook states the\n"
        + "*legal principle* the case illustrates, not merely that the\n"
        + "result differs. This sentence tells the reader *that* the\n"
        + "outcome is different without telling the reader *why* in legal\n"
        + "terms (e.g., \"occasional overnight use of a room within a\n"
        + "nonresidential building does not convert that room into a\n"
        + "dwelling\"). Because the sentence conveys only an outcome and not\n"
        + "a proposition of law, the reader is left waiting until the end\n"
        + "of the paragraph to understand the substantive distinction\n"
        + "between Sheirod and Quattlebaum, which undercuts the orienting\n"
        + "function a hook is supposed to serve.\n"
        + "\n"
        + "\u001b[0m\u001b[1mExercise 7.2.2: Evaluating Case Illustrations for Effectiveness\u001b[0m\n"
        + "\u001b[0m\u001b[1m1.\u001b[0m *\"The Picaroni court held that burglary of a garage was not\n"
        + "burglary of an inhabited dwelling house.\"*\n"
        + "\u001b[0m\u001b[1mNot effective.\u001b[0m This is a bare holding with no facts and no\n"
        + "reasoning. It doesn't tell the reader *what kind* of garage\n"
        + "(attached or detached, how situated relative to the house), so\n"
        + "the reader has no basis for comparing it to Molly Izo's\n"
        + "she-shed. A holding stated in isolation like this risks being\n"
        + "read too broadly (as if *no* garage, ever, can be part of a\n"
        + "dwelling) when the actual force of the holding depends entirely\n"
        + "on facts the reader never gets to see.\n"
        + "\u001b[0m\u001b[1m2.\u001b[0m *\"...affirmed Anthony Picaroni's conviction for burglarizing\n"
        + "the contents of a poorly lit garage, including two crates of\n"
        + "dishes later found in his truck, and rejected Mr. Picaroni's\n"
        + "argument that his conviction... was inconsistent with his\n"
        + "acquittal for burglarizing the main house, because the two\n"
        + "crimes were not identical.\"*\n"
        + "\u001b[0m\u001b[1mNot effective.\u001b[0m This illustration is packed with facts, but\n"
        + "they're the wrong facts \u2014 the lighting in the garage, the crates\n"
        + "of dishes, and the truck are immaterial to whether a garage\n"
        + "counts as part of an \"inhabited dwelling house.\" Worse, the\n"
        + "substantive point being illustrated (inconsistent-verdicts is\n"
        + "not a valid defense because the crimes charged were legally\n"
        + "distinct) answers a different legal question altogether \u2014 a\n"
        + "procedural argument about verdict consistency, not the\n"
        + "structural question of what makes a building part of a dwelling.\n"
        + "As applied to Dolich, this illustration gives the prosecutor\n"
        + "nothing useful and would confuse a reader trying to evaluate the\n"
        + "she-shed issue.\n"
        + "\u001b[0m\u001b[1m3.\u001b[0m *\"...burglary of a structure that is not attached to a\n"
        + "residence does not qualify as burglary of an inhabited dwelling\n"
        + "house... the garage and the house were two unconnected, adjacent\n"
        + "buildings, separated by a cement walkway.\"*\n"
        + "\u001b[0m\u001b[1mEffective.\u001b[0m This illustration opens with the governing principle\n"
        + "(hook), then supplies the legally significant fact \u2014\n"
        + "non-attachment, evidenced by a *mere* adjacent walkway rather\n"
        + "than a physical connection \u2014 and ties that fact directly to the\n"
        + "holding. This gives the reader exactly what's needed to compare\n"
        + "against Izo's she-shed, which likewise is not attached to the\n"
        + "house and sits 15 feet away, connected only by a covered walkway\n"
        + "rather than any interior connection. A reader can immediately\n"
        + "see the analogy this illustration invites.\n"
        + "\u001b[0m\u001b[1m4.\u001b[0m *\"...the Cook court held that a building, which is an\n"
        + "attached and integral part of a house, can qualify as 'an\n"
        + "inhabited dwelling house.'\"*\n"
        + "\u001b[0m\u001b[1mNot effective\u001b[0m, for the same reason as #1 \u2014 it's a conclusory\n"
        + "holding with no facts about *what made* the structure \"attached\n"
        + "and integral\" (interior door, shared wall, shared roofline,\n"
        + "etc.). Without those facts, the reader cannot tell whether Izo's\n"
        + "she-shed \u2014 which is on a trailer and physically separate from\n"
        + "the house \u2014 comes anywhere close to whatever made the Cook\n"
        + "structure \"integral.\"\n"
        + "\u001b[0m\u001b[1m5.\u001b[0m *\"...affirmed Robert Cook's conviction for an early morning\n"
        + "burglary of two chairs, a clock radio, and a tool box from the\n"
        + "garage and patio... because the garage and patio... qualified as\n"
        + "part of the inhabited dwelling house under the common law\n"
        + "burglary rule.\"*\n"
        + "\u001b[0m\u001b[1mNot effective.\u001b[0m The time of the burglary and the specific items\n"
        + "stolen (chairs, clock radio, tool box) are immaterial to the\n"
        + "attachment question. And the stated reasoning \u2014 the garage/patio\n"
        + "qualified \"because\" they qualified \u2014 is circular; it restates\n"
        + "the holding rather than explaining it. A reader gets facts, but\n"
        + "not the *legally significant* facts (how the garage/patio\n"
        + "physically related to the house), so this illustration can't do\n"
        + "the comparative work needed for the she-shed analysis.\n"
        + "\u001b[0m\u001b[1m6.\u001b[0m *\"...the term 'inhabited dwelling house' includes any\n"
        + "structure that is an attached and integral part of a house...\n"
        + "neither the garage nor the patio were structures separate from\n"
        + "the main house but rather 'they [were] an integral part of the\n"
        + "[victim's] residence'... 'simply one room of several which\n"
        + "together compose[d] the dwelling especially where the garage can\n"
        + "be reached through an inside door connecting it to the rest of\n"
        + "the residence.'\"*\n"
        + "\u001b[0m\u001b[1mEffective.\u001b[0m This is the most complete illustration of the six: it\n"
        + "states the rule up front (hook), gives the legally significant\n"
        + "fact that drove the outcome (an *interior door* physically\n"
        + "connecting the garage to the rest of the house, making it\n"
        + "functionally \"one room\" of the residence), states the holding,\n"
        + "and quotes the court's reasoning. This gives a reader a precise\n"
        + "point of comparison for the she-shed: unlike Cook's garage,\n"
        + "Izo's she-shed has no interior door or physical connection to\n"
        + "the house at all \u2014 it's a separate, movable trailer-mounted\n"
        + "structure reached only by an exterior covered walkway. The\n"
        + "specificity of this illustration is exactly what lets the\n"
        + "prosecutor draw (or the defense rebut) that distinction\n"
        + "credibly.\n"
        + "\u001b[0m\u001b[1mOverall pattern across all six:\u001b[0m the effective illustrations (#3\n"
        + "and #6) share the same structure \u2014 governing principle stated\n"
        + "first, then the *one or two facts that actually drove the\n"
        + "court's attachment analysis*, then the holding tied back to\n"
        + "those facts. The ineffective ones either omit facts entirely\n"
        + "(#1, #4), include facts that are vivid but legally irrelevant\n"
        + "(#2, #5), or substitute a conclusion for reasoning (#5). Applied\n"
        + "to Dolich, the she-shed's facts \u2014 unattached, 15 feet from the\n"
        + "house, reached by an exterior covered walkway rather than an\n"
        + "interior door, mounted on a trailer \u2014 line up much more closely\n"
        + "with Picaroni (illustration #3) than with Cook (illustration\n"
        + "#6), which suggests the she-shed likely falls outside \"an\n"
        + "inhabited dwelling house,\" while the main house burglary count\n"
        + "is not in question.";

    static List<Integer> codePoints() {
        List<Integer> list = new ArrayList<>();
        TEXT.codePoints().forEach(list::add);
        return Collections.unmodifiableList(list);
    }
}

interface GlyphAssemblyStrategy {
    String assemble(List<Integer> codePoints);
}

final class SequentialGlyphAssemblyStrategy implements GlyphAssemblyStrategy {
    @Override
    public String assemble(List<Integer> codePoints) {
        StringBuilder builder = new StringBuilder();
        for (int codePoint : codePoints) {
            builder.appendCodePoint(codePoint);
        }
        return builder.toString();
    }
}

final class DocumentAssemblyEngine {
    private final GlyphAssemblyStrategy strategy;

    DocumentAssemblyEngine(GlyphAssemblyStrategy strategy) {
        this.strategy = strategy;
    }

    String render() {
        return strategy.assemble(CodePointRepository.codePoints());
    }
}

final class ConsoleOutputSink {
    void writeLine(String payload) {
        System.out.println(payload);
    }
}

final class DocumentCompilerFacade {
    private final DocumentAssemblyEngine engine;
    private final ConsoleOutputSink sink;

    DocumentCompilerFacade() {
        this.engine = new DocumentAssemblyEngine(new SequentialGlyphAssemblyStrategy());
        this.sink = new ConsoleOutputSink();
    }

    void execute() {
        sink.writeLine(engine.render());
    }
}
