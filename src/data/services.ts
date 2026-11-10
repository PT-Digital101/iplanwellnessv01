import pages from './service-pages.json';

/** Rich page content per service (hero, "suitable for", process, why-us), extracted from the V3 design. */
export type ServicePage = (typeof pages)[keyof typeof pages];

export interface Service {
	slug: keyof typeof pages;
	/** English name (footer, cards, breadcrumbs) */
	name: string;
	/** Label used in the header mega menu */
	menuLabel: string;
	/** Thai service name */
	nameTh: string;
	/** Short Thai line used on the home grid and services cards */
	short: string;
	/** Longer Thai summary used on the Our Services list */
	summary: string;
	/** Key in src/data/images.json */
	image: string;
	/** SEO overrides (fill from the All in One SEO export) */
	seoTitle?: string;
	seoDescription?: string;
}

// Order = header mega menu / footer order in the design.
export const SERVICES: Service[] = [
	{
		slug: 'wellness-branding',
		seoTitle: 'Wellness Branding รับสร้างแบรนด์ธุรกิจสุขภาพและความงาม',
		name: 'Wellness Branding',
		menuLabel: 'Wellness and Medical Branding',
		nameTh: 'สร้างแบรนด์ Wellness',
		short: 'สร้างภาพลักษณ์แบรนด์สุขภาพและการแพทย์อย่างมืออาชีพ',
		summary:
			'ยกระดับภาพลักษณ์แบรนด์สุขภาพ ความงาม และการแพทย์ของคุณอย่างมืออาชีพ ด้วยบริการที่ครอบคลุมตั้งแต่การวางกลยุทธ์แบรนด์ ไปจนถึงการออกแบบที่พร้อมใช้งานจริง',
		image: 'service-wellness-branding',
	},
	{
		slug: 'wellness-and-medical-marketing',
		seoTitle: 'Wellness & Medical Marketing การตลาดสายสุขภาพครบวงจร',
		name: 'Wellness and Medical Marketing',
		menuLabel: 'Wellness Medical Marketing',
		nameTh: 'การตลาดสายสุขภาพ',
		short: 'ทำการตลาดครบวงจรสำหรับคลินิก โรงพยาบาล และธุรกิจสุขภาพ',
		summary:
			'วางแผนและบริหารแคมเปญการตลาดดิจิทัลที่วัดผลได้ ตั้งแต่การสร้างการรับรู้, การยิงโฆษณา ไปจนถึงการปิดการขาย เพื่อสร้างการเติบโตทางธุรกิจอย่างยั่งยืนในโลกออนไลน์',
		image: 'service-medical-marketing',
	},
	{
		slug: 'wellness-tourism-marketing',
		seoTitle: 'Wellness Tourism Marketing การตลาดท่องเที่ยวเชิงสุขภาพ',
		name: 'Wellness Tourism Marketing',
		menuLabel: 'Wellness Tourism Marketing',
		nameTh: 'การตลาดท่องเที่ยวเชิงสุขภาพ',
		short: 'วางกลยุทธ์และแคมเปญดึงดูดนักท่องเที่ยวสุขภาพจากทั่วโลก',
		summary:
			'วางกลยุทธ์และสร้างแคมเปญการตลาดที่ตรงใจนักท่องเที่ยวจากทั่วโลก เพื่อให้แบรนด์ของคุณเป็นที่รู้จักและได้รับความไว้วางใจในระดับสากล',
		image: 'service-wellness-tourism',
	},
	{
		slug: 'aesthetic-clinic-marketing',
		seoTitle: 'Aesthetic Clinic Marketing การตลาดคลินิกความงาม',
		name: 'Aesthetic Clinic Marketing',
		menuLabel: 'Aesthetic Clinic Marketing',
		nameTh: 'การตลาดสำหรับคลินิกความงาม',
		short: 'เพิ่มยอดจองและสร้างความน่าเชื่อถือให้คลินิกความงาม',
		summary:
			'สร้างสรรค์แคมเปญสำหรับคลินิกความงาม ที่เน้นสร้างความน่าเชื่อถือ ถูกต้องตามจรรยาบรรณ และสร้างผลลัพธ์ทางธุรกิจที่จับต้องได้และวัดผลได้จริง',
		image: 'service-aesthetic-clinic',
	},
	{
		slug: 'wellness-videos-production',
		seoTitle: 'Wellness Videos Production ผลิตวิดีโอธุรกิจสุขภาพ คลินิก สปา',
		name: 'Wellness Videos Production',
		menuLabel: 'Wellness Videos Production',
		nameTh: 'ผลิตวิดีโอสำหรับธุรกิจ Wellness',
		short: 'ผลิตวิดีโอโปรโมตสำหรับคลินิก ผลิตภัณฑ์ หรือแบรนด์ Wellness',
		summary:
			'สร้างสรรค์วิดีโอที่สร้างความน่าเชื่อถือและกระตุ้นการตัดสินใจ โดยทีมงานที่เชี่ยวชาญและเข้าใจในธุรกิจสุขภาพอย่างแท้จริง เพื่อช่วยให้แบรนด์ของคุณสร้างความสัมพันธ์ที่แข็งแกร่งกับลูกค้า ผ่านการสื่อสารที่ตรงจุดและจริงใจ',
		image: 'service-video-production',
	},
	{
		slug: 'brand-consultancy',
		seoTitle: 'Brand Consultancy ที่ปรึกษาแบรนด์ Healthcare & Wellness',
		name: 'Brand Consultancy',
		menuLabel: 'Brand Consultancy',
		nameTh: 'ที่ปรึกษาด้านแบรนด์ Healthcare & Wellness',
		short: 'ที่ปรึกษาด้านแบรนด์เพื่อสร้างจุดยืนและความแตกต่างให้ธุรกิจ',
		summary:
			'บริการที่ปรึกษาเชิงกลยุทธ์สำหรับธุรกิจสุขภาพโดยเฉพาะ เราช่วยกำหนดทิศทาง, จุดยืน และบุคลิกของแบรนด์ เพื่อสร้างรากฐานที่แข็งแกร่งและเป็นระบบให้กับแบรนด์',
		image: 'service-brand-consultancy',
	},
	{
		slug: 'website-and-seo-service',
		seoTitle: 'รับทำเว็บไซต์และ SEO สำหรับคลินิกและธุรกิจสุขภาพ',
		name: 'Website + SEO Service',
		menuLabel: 'Website + SEO Service',
		nameTh: 'บริการสร้างเว็บไซต์ และ SEO',
		short: 'สร้างเว็บไซต์คุณภาพ พร้อมรองรับ SEO เพื่อเข้าถึงกลุ่มสุขภาพ',
		summary:
			'ออกแบบและสร้างเว็บไซต์สำหรับธุรกิจสุขภาพ พร้อมทั้งวางโครงสร้าง SEO ที่แข็งแกร่งตั้งแต่วันแรก เพื่อให้ลูกค้าเป้าหมายค้นหาคุณเจอ และตัดสินใจเลือกใช้บริการอย่างมั่นใจ',
		image: 'service-website-seo',
	},
	{
		slug: 'ai-marketing',
		seoTitle: 'AI Marketing การตลาดด้วย AI สำหรับธุรกิจสุขภาพและความงาม',
		name: 'AI Marketing',
		menuLabel: 'AI Marketing',
		nameTh: 'บริการตลาด AI Marketing',
		short: 'ทำการตลาดด้วย AI เพื่อเข้าถึงกลุ่มเป้าหมายด้านสุขภาพ',
		summary:
			'ขับเคลื่อนการตลาดสุขภาพด้วยพลังของ AI และความเชี่ยวชาญของเรา เพื่อสร้างแคมเปญที่แม่นยำ, รวดเร็ว, และวัดผลได้เหนือกว่า ช่วยประหยัดเวลาและเพิ่มประสิทธิภาพงบประมาณของคุณ',
		image: 'service-ai-marketing',
	},
	{
		slug: 'health-tech-solution',
		seoTitle: 'Health Tech Solution ระบบจองคิวผ่าน LINE และ CRM คลินิก',
		name: 'Health Tech Solution',
		menuLabel: 'Health Tech Solution',
		nameTh: 'ระบบจัดการคลินิกและธุรกิจสุขภาพ',
		short: 'จัดการคิวนัดหมายอัตโนมัติ 24 ชม.ผ่านระบบจองคิวผ่าน LINE พร้อม CRM',
		summary:
			'อำนวยความสะดวกให้ลูกค้าและลดภาระงานแอดมิน ด้วยระบบนัดหมายอัตโนมัติผ่าน LINE และระบบจัดการลูกค้าสัมพันธ์ (CRM) ที่ออกแบบมาเพื่อธุรกิจสุขภาพโดยเฉพาะ',
		image: 'service-health-tech',
	},
	{
		slug: 'wellness-marketplace',
		seoTitle: 'Wellness Marketplace ขยายช่องทางขายสินค้าสุขภาพ + Affiliate',
		name: 'Wellness Marketplace',
		menuLabel: 'Wellness Marketplace',
		nameTh: 'ขยายช่องทางการขายบน Marketplace',
		short: 'ขยายโอกาสทางธุรกิจ-เพิ่มยอดขายผ่าน Marketplace พร้อมระบบ Affiliate',
		summary:
			'เพิ่มโอกาสให้ผลิตภัณฑ์และบริการของคุณเข้าถึงกลุ่มลูกค้าที่พร้อมซื้อ บนแพลตฟอร์ม Marketplace สำหรับธุรกิจสายสุขภาพ พร้อมด้วยระบบตัวแทน (Affiliate) ที่ช่วยผลักดันยอดขายให้คุณโดยตรง',
		image: 'service-wellness-marketplace',
	},
	{
		slug: 'healthcare-marketing',
		seoTitle: 'Healthcare Marketing การตลาดโรงพยาบาลและคลินิก',
		name: 'Healthcare Marketing',
		menuLabel: 'Healthcare Marketing',
		nameTh: 'การตลาดสำหรับคลินิกและโรงพยาบาล',
		short: 'สร้างความน่าเชื่อถือและเข้าถึงผู้ป่วยยุคดิจิทัล',
		summary:
			'วางกลยุทธ์การตลาดที่สร้างความไว้วางใจให้โรงพยาบาลและคลินิกสื่อสารข้อมูลที่ซับซ้อนให้เข้าใจง่าย และเข้าถึงกลุ่มผู้ป่วยที่ใช่ได้อย่างมีประสิทธิภาพ',
		image: 'service-healthcare-marketing',
	},
];

/** Card order of the lime "บริการของเรา" grid on the Our Services page (as designed). */
export const SERVICES_GRID_ORDER: Service['slug'][] = [
	'wellness-branding',
	'wellness-tourism-marketing',
	'brand-consultancy',
	'website-and-seo-service',
	'health-tech-solution',
	'wellness-and-medical-marketing',
	'aesthetic-clinic-marketing',
	'wellness-videos-production',
	'ai-marketing',
	'wellness-marketplace',
	'healthcare-marketing',
];

export const getService = (slug: string) => SERVICES.find((s) => s.slug === slug);
export const getServicePage = (slug: Service['slug']) => pages[slug];
