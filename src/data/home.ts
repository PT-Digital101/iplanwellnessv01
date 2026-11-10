import type { Service } from './services';

/** Client logos (WebP, white + forest variants in src/assets/images/clients/). */
export const CLIENTS: { name: string; logo: string }[] = [
	{ name: 'Wellness Thailand', logo: 'wellness-thailand' },
	{ name: 'Wellness x Academy', logo: 'wellness-x-academy' },
	{ name: 'Zlive Matter', logo: 'zlive-matter' },
	{ name: 'Berry Dent', logo: 'berry-dent' },
	{ name: 'AGS Asia Greatest Sky', logo: 'ags-asia-greatest-sky' },
	{ name: 'TNK Beauty', logo: 'tnk-beauty' },
	{ name: 'Glamour Salon System (Thailand)', logo: 'glamour-salon-system-thailand' },
	{ name: 'ZINCIA Aesthetic Clinic', logo: 'zincia-aesthetic-clinic' },
	{ name: '120 Wellness Villa', logo: '120-wellness-villa' },
	{ name: 'EXO Skin', logo: 'exo-skin' },
	{ name: 'Vivère Wellness', logo: 'vivere-wellness' },
	{ name: 'Follizin', logo: 'follizin' },
];

export const INDUSTRIES: { title: string; text: string; service?: Service['slug']; image?: string; cta?: boolean }[] = [
	{
		title: 'Wellness Tourism',
		text: 'กลยุทธ์การตลาดที่ออกแบบเฉพาะสำหรับธุรกิจท่องเที่ยวเชิงสุขภาพ สร้างประสบการณ์ที่ดึงดูดนักท่องเที่ยวต่างชาติและกลุ่ม Medical Tourism',
		service: 'wellness-tourism-marketing',
		image: 'industry-wellness-tourism',
	},
	{
		title: 'Aesthetic Clinic',
		text: 'การสร้างแบรนด์และทำการตลาดดิจิทัลสำหรับคลินิกเสริมความงามและเวชศาสตร์ชะลอวัย สื่อสารภาพลักษณ์อย่างมืออาชีพและสร้างความน่าเชื่อถือให้กับผู้บริโภค',
		service: 'aesthetic-clinic-marketing',
		image: 'industry-aesthetic-clinic',
	},
	{
		title: 'Hospital',
		text: 'กลยุทธ์การสื่อสารและการตลาดออนไลน์สำหรับโรงพยาบาลและศูนย์สุขภาพ เน้นความน่าเชื่อถือ ความปลอดภัย และคุณภาพการรักษา',
		service: 'healthcare-marketing',
		image: 'industry-hospital',
	},
	{ title: 'All Wellness', text: 'ก้าวสู่โลกแห่งธุรกิจ Wellness', cta: true },
	{
		title: 'Spa & Massage',
		text: 'การวางแผนแบรนด์และการตลาดที่สะท้อนเอกลักษณ์และบรรยากาศแห่งการผ่อนคลาย พร้อมสร้างประสบการณ์ดิจิทัลที่เข้าถึงลูกค้ากลุ่มเป้าหมาย',
		service: 'wellness-branding',
		image: 'industry-spa-massage',
	},
	{
		title: 'Wellness Product',
		text: 'กลยุทธ์การสร้างแบรนด์ ผลิตภัณฑ์เสริมอาหาร สกินแคร์ และผลิตภัณฑ์เพื่อสุขภาพ ให้มีภาพลักษณ์ที่แตกต่างและครองใจผู้บริโภค',
		service: 'wellness-marketplace',
		image: 'industry-wellness-product',
	},
];

/** "กระบวนการทำงาน" accordion on the home page: 11 services × 4 steps. */
export const PROCESS: { title: string; service: Service['slug']; steps: [string, string][] }[] = [
	{ title: 'Wellness Branding', service: 'wellness-branding', steps: [['Brand Research & Discovery', 'วิเคราะห์แบรนด์ กลุ่มเป้าหมาย และโอกาสทางการตลาด'], ['Brand Strategy', 'กำหนดกลยุทธ์การสื่อสารและการสร้างคุณค่าเฉพาะแบรนด์'], ['Creative Development', 'ออกแบบโลโก้ สี ฟอนต์ และองค์ประกอบแบรนด์'], ['Brand Guidelines', 'จัดทำคู่มือแบรนด์สำหรับการสื่อสารทุกรูปแบบ']] },
	{ title: 'Wellness Tourism Marketing', service: 'wellness-tourism-marketing', steps: [['Market Insights', 'วิเคราะห์พฤติกรรมและแนวโน้มของนักท่องเที่ยวเชิงสุขภาพ'], ['Campaign Strategy', 'วางแผนแคมเปญและกิจกรรมเพื่อดึงดูดกลุ่ม Medical Tourism'], ['Content Marketing', 'สร้างคอนเทนต์เชิงประสบการณ์ที่สะท้อนคุณค่าของสถานที่/บริการ'], ['Digital Ads', 'บริหารโฆษณาออนไลน์เพื่อเพิ่มการเข้าถึงและการจอง']] },
	{ title: 'Wellness and Medical Marketing', service: 'wellness-and-medical-marketing', steps: [['Regulation Awareness', 'ทำการตลาดภายใต้ข้อกำหนดและมาตรฐานการแพทย์'], ['Positioning & Branding', 'สร้างจุดยืนที่แตกต่างและน่าเชื่อถือในตลาด'], ['Educational Content', 'ผลิตคอนเทนต์ที่ให้ความรู้และเสริมความไว้วางใจ'], ['Digital Outreach', 'ทำแคมเปญโฆษณาและโซเชียลมีเดีย เพื่อเชื่อมต่อกับผู้ป่วยเป้าหมาย']] },
	{ title: 'Aesthetic Clinic Marketing', service: 'aesthetic-clinic-marketing', steps: [['Persona Development', 'สร้างโปรไฟล์กลุ่มลูกค้าเป้าหมายที่ชัดเจน'], ['Service Highlighting', 'สร้างเรื่องราวและภาพลักษณ์ให้บริการและแพทย์โดดเด่น'], ['Social Media Marketing', 'บริหารเพจและสร้างการมีส่วนร่วมผ่านแพลตฟอร์มหลัก'], ['Clinic Branding', 'วางกลยุทธ์ภาพลักษณ์ที่ทำให้คลินิกแตกต่างจากคู่แข่ง']] },
	{ title: 'Wellness Videos Production', service: 'wellness-videos-production', steps: [['Concept Development', 'พัฒนาแนวคิดวิดีโอที่สะท้อนอัตลักษณ์และคุณค่าของแบรนด์สายสุขภาพอย่างชัดเจน'], ['Script & Storyboard', 'เขียนสคริปต์และสตอรีบอร์ดแบบเล่าเรื่อง สร้างความน่าเชื่อถือและความเข้าใจด้าน Wellness/Medical'], ['Production', 'ถ่ายทำมาตรฐานมืออาชีพ โดยทีมที่เชี่ยวชาญบริบทคลินิก โรงพยาบาล สปา และผลิตภัณฑ์เพื่อสุขภาพ'], ['Post-Production', 'ตัดต่อ เกรดสี ใส่กราฟิก/ซับไตเติล และมิกซ์เสียง ให้พร้อมใช้บนเว็บไซต์ โซเชียล และโฆษณาดิจิทัล']] },
	{ title: 'Brand Consultancy', service: 'brand-consultancy', steps: [['Brand Audit', 'ตรวจสอบและประเมินภาพรวมของแบรนด์สุขภาพและคลินิก เพื่อหาจุดแข็งและจุดที่ควรปรับปรุง'], ['Market & Competitor Analysis', 'วิเคราะห์ตลาดและคู่แข่ง เพื่อระบุตำแหน่งที่เหมาะสมสำหรับแบรนด์'], ['Strategic Recommendations', 'เสนอแนวทางกลยุทธ์ที่สร้างความแตกต่างและความน่าเชื่อถือ'], ['Implementation Support', 'ช่วยนำกลยุทธ์ไปสู่การปฏิบัติจริง พร้อมติดตามและประเมินผล']] },
	{ title: 'Website + SEO Service', service: 'website-and-seo-service', steps: [['Compliance Research', 'ตรวจสอบข้อกำหนดและมาตรฐานด้านการแพทย์ เพื่อให้เว็บไซต์สอดคล้องตามกฎหมาย'], ['Positioning Strategy', 'วางกลยุทธ์การสื่อสารที่เหมาะสมในตลาดสุขภาพและความงามออนไลน์'], ['Educational Content', 'ผลิตบทความและเนื้อหาที่ให้ความรู้ สร้างความน่าเชื่อถือ และดึงดูดกลุ่มเป้าหมาย'], ['Patient Outreach', 'ใช้ SEO และโซเชียลมีเดียเพื่อเข้าถึงผู้ป่วยและลูกค้าที่ตรงกลุ่ม']] },
	{ title: 'AI Marketing', service: 'ai-marketing', steps: [['Needs Assessment', 'วิเคราะห์เป้าหมายและความต้องการเฉพาะของธุรกิจสุขภาพและความงาม'], ['AI Tool Integration', 'เลือกและติดตั้งเครื่องมือ AI ที่ช่วยเพิ่มประสิทธิภาพทางการตลาด'], ['Campaign Automation', 'ใช้ AI จัดการและปรับแต่งแคมเปญให้เหมาะสมกับกลุ่มเป้าหมาย'], ['Data-Driven Optimization', 'วิเคราะห์ข้อมูลแบบ Real-time เพื่อปรับกลยุทธ์และเพิ่มผลลัพธ์ทางการตลาด']] },
	{ title: 'Health Tech Solution', service: 'health-tech-solution', steps: [['Automated Booking', 'ระบบนัดหมายอัตโนมัติ 24 ชั่วโมงผ่าน LINE'], ['Smart Reminder & Follow-up', 'ระบบแจ้งเตือนและติดตามผลอัจฉริยะ ลดปัญหา No-Show'], ['Integrated CRM', 'ระบบจัดการลูกค้าสัมพันธ์เพื่อบริการที่เฉพาะบุคคล'], ['Data & Analytics', 'แดชบอร์ดสรุปข้อมูลเพื่อการวางแผนธุรกิจ']] },
	{ title: 'Wellness Marketplace', service: 'wellness-marketplace', steps: [['Expand Your Reach', 'ขยายการเข้าถึงกลุ่มลูกค้าคนรักสุขภาพ'], ['New Sales Channel', 'เพิ่มช่องทางการขายออนไลน์ที่น่าเชื่อถือ'], ['Affiliate Marketing System', 'ระบบตัวแทนช่วยขาย (Affiliate) เพื่อสร้างการเติบโต'], ['Brand Visibility & Placement', 'เพิ่มการมองเห็นและวางตำแหน่งแบรนด์ท่ามกลางสินค้าคุณภาพ']] },
	{ title: 'Healthcare Marketing', service: 'healthcare-marketing', steps: [['Healthcare Marketing Strategy', 'กำหนดกลยุทธ์และจุดยืนทางการตลาดที่สร้างความน่าเชื่อถือ'], ['Patient Education Content', 'สร้างคอนเทนต์ให้ความรู้ทางการแพทย์ที่ถูกต้องและเข้าใจง่าย'], ['Ethical Digital Campaigns', 'บริหารจัดการแคมเปญโฆษณาออนไลน์ตามหลักจรรยาบรรณ'], ['Online Reputation Management', 'บริหารจัดการภาพลักษณ์และรีวิวบนช่องทางออนไลน์']] },
];

export const FAQS = [
	{
		q: 'ทำไมธุรกิจ Wellness ถึงต้องการ Branding และการสื่อสารเฉพาะทาง?',
		a: 'ธุรกิจ Wellness มีความซับซ้อนกว่าธุรกิจทั่วไป ต้องสื่อสารทั้งเรื่องคุณภาพ ความน่าเชื่อถือ และความใส่ใจในสุขภาพของลูกค้าไปพร้อมกัน การสร้าง Branding และการสื่อสารเฉพาะทางจึงช่วยให้ธุรกิจสะท้อนความน่าเชื่อถือ สร้างภาพลักษณ์ที่แตกต่าง และเข้าถึงกลุ่มเป้าหมายได้อย่างตรงจุด',
	},
	{
		q: 'I Plan Wellness แตกต่างจากเอเจนซี่ทั่วไปอย่างไร?',
		a: 'เราไม่ใช่แค่เอเจนซี่ที่ทำการตลาด แต่เชี่ยวชาญในการสร้างแบรนด์และกลยุทธ์การสื่อสารสำหรับธุรกิจ Wellness โดยเฉพาะ เราเข้าใจ Pain Point ของผู้ประกอบการในสายสุขภาพ และแปลงสิ่งเหล่านี้ให้เป็น Branding ที่มีพลังและน่าเชื่อถือ ไม่ว่าจะเป็นการออกแบบภาพลักษณ์ เนื้อหา วิดีโอ หรือช่องทางการสื่อสารต่าง ๆ',
	},
	{
		q: 'บริการของเราช่วยสร้างความน่าเชื่อถือและขยายฐานลูกค้าได้อย่างไร?',
		a: 'เราช่วยพัฒนาแบรนด์ให้แข็งแรงตั้งแต่ การวางกลยุทธ์ การเล่าเรื่อง (Brand Storytelling) การออกแบบ และการสื่อสารในทุกช่องทาง ซึ่งทำให้ธุรกิจดูเป็นมืออาชีพและน่าเชื่อถือมากขึ้น เมื่อลูกค้าเกิดความมั่นใจ ยอดขายและการเติบโตของธุรกิจก็จะตามมาอย่างยั่งยืน',
	},
	{
		q: 'ธุรกิจที่เพิ่งเริ่มต้นสามารถใช้บริการของ I Plan Wellness ได้หรือไม่?',
		a: 'ธุรกิจที่เพิ่งเริ่มก่อตั้งก็สามารถใช้บริการของเราได้เช่นกัน เราช่วยตั้งแต่การวางรากฐานของแบรนด์ การออกแบบเอกลักษณ์ที่ชัดเจน ไปจนถึงการวางกลยุทธ์ด้านการสื่อสารที่เหมาะกับตลาดเป้าหมาย เพื่อให้ธุรกิจเริ่มต้นได้อย่างมั่นใจ และพร้อมต่อยอดสู่การขยายตลาดในอนาคต',
	},
];

export const VIDEO_TAGS = [
	{ label: 'Healthcare', color: 'var(--lime)' },
	{ label: 'Wellness Tourism', color: 'var(--cream)' },
	{ label: 'Aesthetic Clinic', color: 'var(--sand)' },
	{ label: 'Wellness Products', color: 'var(--olive)' },
];

export const ABOUT = {
	approach: [
		{ t: 'Strategy-First', d: 'ทุกโปรเจกต์เริ่มต้นที่ ‘กลยุทธ์’ ไม่ใช่แค่ความคิดสร้างสรรค์ การวิเคราะห์ข้อมูลและทำความเข้าใจเป้าหมายทางธุรกิจของคุณจึงเป็นขั้นตอนแรกเสมอ เพื่อให้ทุกการออกแบบและการสื่อสารทำงานเพื่อผลลัพธ์ที่วัดผลได้จริง' },
		{ t: 'Data-Driven Creativity', d: 'ความคิดสร้างสรรค์ที่ดีที่สุดเกิดจากความเข้าใจในข้อมูลเชิงลึก (Insight) การใช้ Data เพื่อขับเคลื่อนไอเดียที่แตกต่างและตรงจุด ทำให้ทุกชิ้นงานไม่เพียงแค่สวยงาม แต่ยังสื่อสารและเข้าถึงกลุ่มเป้าหมายได้อย่างแม่นยำ' },
		{ t: 'Specialized Team', d: 'การมีทีมผู้เชี่ยวชาญที่มุ่งเน้นเฉพาะอุตสาหกรรม Wellness ทำให้ทุกกลยุทธ์ที่เราสร้างสรรค์ มั่นใจได้ว่าจะตอบโจทย์ธุรกิจของคุณ และสร้างความได้เปรียบในการแข่งขันได้อย่างแท้จริง' },
		{ t: 'Growth-Focused Partnership', d: 'ความสำเร็จของลูกค้าคือความสำเร็จของเรา การทำงานอย่างใกล้ชิดเหมือนเป็นทีมเดียวกันจึงเป็นหัวใจสำคัญ เป้าหมายคือการสร้างผลลัพธ์ที่ช่วยขับเคลื่อนการเติบโตทางธุรกิจของคุณอย่างยั่งยืน' },
	],
	why: [
		{ t: 'ความเชี่ยวชาญเฉพาะทาง', d: 'ความเข้าใจในธุรกิจ Wellness อย่างลึกซึ้ง คือสิ่งที่ทำให้กลยุทธ์ของเราแตกต่างและตอบโจทย์ความท้าทายของตลาดสุขภาพได้อย่างแท้จริง' },
		{ t: 'บริการครบวงจร', d: 'บริการที่ครอบคลุมตั้งแต่แบรนด์, การตลาด, ไปจนถึงเทคโนโลยี ทำให้ทุกองค์ประกอบทำงานสอดประสานกันอย่างไร้รอยต่อ เพื่อเป้าหมายทางธุรกิจเดียวกัน' },
		{ t: 'ผลลัพธ์ที่วัดผลได้จริง', d: 'ทุกกลยุทธ์ถูกออกแบบมาเพื่อขับเคลื่อนธุรกิจ ไม่ใช่แค่สร้างสรรค์งานที่สวยงาม แต่คือการสร้างการเติบโต, เพิ่มยอดขาย, และสร้างแบรนด์ที่แข็งแกร่งในระยะยาว' },
		{ t: 'การทำงานแบบพาร์ทเนอร์', d: 'การทำงานอย่างใกล้ชิดเหมือนเป็นส่วนหนึ่งของทีมคุณ คือแนวทางที่ช่วยให้เราสามารถปรับกลยุทธ์และสร้างความสำเร็จที่ยั่งยืนร่วมกัน' },
	],
};

export const BUDGETS = [
	'ไม่เกิน 30,000 ต่อเดือน',
	'ไม่เกิน 50,000 ต่อเดือน',
	'ไม่เกิน 100,000 ต่อเดือน',
	'ไม่เกิน 200,000 ต่อเดือน',
	'ไม่เกิน 300,000 ต่อเดือน',
	'ไม่เกิน 500,000 ต่อเดือน',
	'ไม่เกิน 1,000,000 ต่อเดือน',
];
