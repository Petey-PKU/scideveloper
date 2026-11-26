// Gene subsets from the corresponding human pathway entries at https://www.kegg.jp/entry/.
export const keggPathways = [
  {
    id: 'hsa01521', name: 'EGFR tyrosine kinase inhibitor resistance', classification: 'Human Diseases; Drug resistance: antineoplastic',
    description: 'RTK bypass, downstream signaling and apoptosis pathways implicated in EGFR inhibitor resistance.',
    members: '1950:EGF 1956:EGFR 2064:ERBB2 2065:ERBB3 207:AKT1 3082:HGF 3845:KRAS 4233:MET 5290:PIK3CA 5728:PTEN 558:AXL 10018:BCL2L11 2475:MTOR 5594:MAPK1 5595:MAPK3 5604:MAP2K1 5894:RAF1 2885:GRB2',
  },
  {
    id: 'hsa04115', name: 'p53 signaling pathway', classification: 'Cellular Processes; Cell growth and death',
    description: 'Cell cycle arrest, apoptosis and other stress responses governed by p53.',
    members: '7157:TP53 1026:CDKN1A 4193:MDM2 4194:MDM4 11200:CHEK2 1111:CHEK1 472:ATM 545:ATR 1647:GADD45A 27113:BBC3 5366:PMAIP1 581:BAX 596:BCL2 598:BCL2L1 317:APAF1 54205:CYCS 842:CASP9 836:CASP3 5054:SERPINE1 7057:THBS1 1017:CDK2 1019:CDK4 1021:CDK6 595:CCND1 898:CCNE1 891:CCNB1 983:CDK1 5728:PTEN',
  },
  {
    id: 'hsa05223', name: 'Non-small cell lung cancer', classification: 'Human Diseases; Cancer: specific types',
    description: 'Receptor kinase, RAS and PI3K signaling and cell-cycle changes in NSCLC.',
    members: '1950:EGF 1956:EGFR 2064:ERBB2 238:ALK 27436:EML4 3082:HGF 4233:MET 2885:GRB2 3845:KRAS 3265:HRAS 673:BRAF 5894:RAF1 5594:MAPK1 5595:MAPK3 5290:PIK3CA 207:AKT1 5728:PTEN 7157:TP53 1026:CDKN1A 1029:CDKN2A 1019:CDK4 1021:CDK6 11186:RASSF1 2272:FHIT 2309:FOXO3 1869:E2F1',
  },
  {
    id: 'hsa04010', name: 'MAPK signaling pathway', classification: 'Environmental Information Processing; Signal transduction',
    description: 'Human kinase cascades downstream of extracellular stimuli, including ERK, JNK and p38.',
    members: '1950:EGF 1956:EGFR 2064:ERBB2 2065:ERBB3 2066:ERBB4 2885:GRB2 6654:SOS1 3845:KRAS 3265:HRAS 4893:NRAS 5894:RAF1 673:BRAF 5604:MAP2K1 5605:MAP2K2 5594:MAPK1 5595:MAPK3 5598:MAPK7 5599:MAPK8 5601:MAPK9 1432:MAPK14 1386:ATF2 2002:ELK1 1843:DUSP1 1844:DUSP2 1845:DUSP3 1850:DUSP8 9479:MAPK8IP1 998:CDC42',
  },
];

// Subsets of human Reactome gene sets, identified by stable Reactome pathway ID.
// Membership reference: https://www.gsea-msigdb.org/gsea/msigdb/human/collections.jsp#C2
export const reactomePathways = [
  {
    id: 'R-HSA-177929', name: 'Signaling by EGFR', description: 'EGFR activation, receptor downregulation and recruitment of signaling adaptors.',
    genes: 'EGF EGFR AREG EREG HBEGF TGFA CBL GAB1 SHC1 SOS1 GRB2 KRAS PLCG1 PIK3CA PIK3R1 ADAM10 ADAM12 ADAM17 SPRY2 EPS15L1 STAM STAM2 LRIG1 PTPRK PTPN12 UBC'.split(' '),
  },
  {
    id: 'R-HSA-3700989', name: 'Transcriptional Regulation by TP53', description: 'Transcriptional responses to p53 activation and regulation of its activity.',
    genes: 'TP53 TP63 TP73 BRCA1 BID MRE11 PHF20 FAS USP2 AIFM2 RRM2B HIPK2 CSNK2A2 TIGAR MLH1 SESN1 BAX PPP1R13B MAPKAPK5 CDKN1A MDM2 BBC3 GADD45A DDB2 PMAIP1'.split(' '),
  },
  {
    id: 'R-HSA-5683057', name: 'MAPK family signaling cascades', description: 'MAP kinase modules that relay signals upstream of transcription and other responses.',
    genes: 'EGFR HGF ERBB3 FGFR1 FGFR2 FGFR3 FGF4 FGF10 FGF20 FGF22 KITLG CDC42 ARAF RAF1 BRAF KRAS NRAS HRAS MAP2K1 MAP2K2 MAPK1 MAPK3 MAPK6 PIK3CB CUL3'.split(' '),
  },
  {
    id: 'R-HSA-1640170', name: 'Cell Cycle', description: 'DNA replication, chromosome segregation and checkpoint machinery.',
    genes: 'BRCA1 TP53 TP53BP1 RAD51 MRE11 E2F2 E2F1 RFC1 RFC2 POLA2 POLD1 MCM10 TUBG2 SPDL1 RSF1 WAPL STAG3 NCAPD2 CENPQ CDK1 CDK2 CDC20 CCNB1 CCNE1 RB1 ATM ATR'.split(' '),
  },
];
