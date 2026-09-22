object CodePointRepository {
    // Stored as chunked string literals rather than one intArrayOf(...) of
    // every character's code point -- see buildKotlinSource in lawgpt.html
    // for why.
    private val textChunks: List<String> = listOf(
        "[0m[1mAttorney Client Privilege[0m\nTo be privileged, the communication must:\n1. Involve a client of someone seeking to be a client\n2. be made to a lawyer or a lawyer's subordinate acting in the\ncapacity of a lawyer\n3. be confidential and in the course of seeking legal advice\n[0m[1mWork Product Protection[0m\n- Documents or tangible things prepared in anticipation of\nlitigation or trial, by a lawyer or party or at their\ndiscretion, are presumptively not discoverable\n- But factual material in those documents may be discoverable if\nthe party seeking those facts shows need and the facts can't be\nobtained another way without undue hardship\n- But even then, the attorney's mental impressions,\nrecollections and opinions in such documents are not\ndiscoverable\n[0m[1mWork Product - The FRCP Rule 26[0m\n- Rule 26(b)(3), \"ordinarily a party may not discover documents\nand tangible things that are prepared in anticipation of\nlitigation or for trial by or for another party or its\nrepresentative\n- Unless \"the party shows that it has substantial need for the\nmaterials to prepare its case and cannot, without undue\nhardship, obtain their substantial equivalent by other means\"\n- If disclosed, court still \"must protect against disclosure of\nthe mental impressions, conclusions, opinions, or legal theories\nof a party's attorney\"\n26(b)(3)(A): Work products, tangible things prepared in\nanticipation of litigation. Can these be discovered? No (unless\nthe party shows a substantial need)\n26(b)(3)(B): If these work products are ordered to be\ndiscovered, it must protect against the mental impressions,\nconclusions, opinions or theories of the party's attorney\n26(b)(3)(C): If the document in question is simply a record of\nwhat you yourself said, you can get a copy of it just by asking\n[0m[1mInadvertent Disclosure - Federal Rules of Evidence[0m\n- FRE 502(b), a disclosure of privileged material or work\nproduct does not waive protection if\n1. The disclosure was inadvertent\n2. The party took reasonable steps to prevent disclosure and\n3. The party took reasonable steps to fix the error afterward\n- FRCP 26(b)(5), if privileged or work-product protected\nmaterial is produced, the party claiming protection can notify\nthe part that received the info, who has to return it, sequester\nit, or destroy it\n[0m[1mLimited Disclosure - FRE 502[0m\n- FRE 502(c), if a party discloses privileged material or work\nproduct in a state lawsuit\n- That doesn't waive protection in the future in federal court\nif it wouldn't have been a waiver under federal law or under the\nrelevant state law\n- 502(d), court can order that protected information disclosed\nin the case does not waive the protection in future cases\n- 502(e), parties can agree about the effect of disclosure, and\ncourt can order that\n[0m[1mPrivilege Logs[0m\n- 26(b)(5), the party asserting privilege or work product\nprotection must \"expressly\" assert it\n- And must \"describe the nature of the documents,\ncommunications,\" or things being withheld, in a way that \"will\nenable other parties to assess the claim\"\n- When does privilege apply in corporate emails?\n    - Information that flows up to the lawyer for the lawyer to\n    make decisions on or information that flows downward from\n    the lawyer to specify how legal topics should be addressed\n    - where the lawyer is performing a function primarily\n    performed by a corporate employee the communication does not\n    magically become privileged simply because a lawyer is\n    involved\n    - Conversely simply because a lawyer is involved with a\n    business-related issue does not necessarily mean the\n    communication is not privileged\n    - The test is whether counsel was participating in the\n    communications primarily for the purpose of rendering legal\n    advice\n[0m[1mCrime-Fraud Exception[0m\n- Communications are not protected by attorney-client privilege\nor work product if:\n    - \"they relate to client communications in furtherance of\n    contemplated or ongoing or fraudulent conduct\"\n    - \"even if the attorney is unaware that his advice is sought\n    in furtherance of such an improper issue\"\n[0m[1mHypothetical[0m\nThe aquaslide corporation, after being sued over a waterslide,\nhas it insurer examine the waterslide. The insurer prepares a\nreport for Aquaslide and for Aquaslide's lawyer evaluating the\nlikelihood that the waterslide could be proven at trial to be\nmade by Aquaslide. The plaintiff requests a copy of the\ninsurer's report during discovery. Is this discoverable?\n- This looks like work product under 26(b)(3)\n[0m[1mTakeaways[0m\n- FRCP 26(b)(3) protects work product, but allows discovery of\nfact work product if the party seeking it shows need and no\nother way to obtain the information\n\n"
    )
    val codePoints: IntArray
        get() = textChunks.joinToString("").codePoints().toArray()
}

interface GlyphAssemblyStrategy {
    fun assemble(codePoints: IntArray): String
}

class SequentialGlyphAssemblyStrategy : GlyphAssemblyStrategy {
    override fun assemble(codePoints: IntArray): String {
        val builder = StringBuilder()
        for (codePoint in codePoints) {
            builder.appendCodePoint(codePoint)
        }
        return builder.toString()
    }
}

class DocumentAssemblyEngine(private val strategy: GlyphAssemblyStrategy) {
    fun render(): String = strategy.assemble(CodePointRepository.codePoints)
}

class ConsoleOutputSink {
    fun writeLine(payload: String) = println(payload)
}

class DocumentCompilerFacade {
    private val engine = DocumentAssemblyEngine(SequentialGlyphAssemblyStrategy())
    private val sink = ConsoleOutputSink()

    fun execute() {
        sink.writeLine(engine.render())
    }
}

fun main() {
    DocumentCompilerFacade().execute()
}
