#define __LIBELF_INTERNAL__ 1
#include "libelf.h"
#include "gelf.h"

#include <vector>
#include <string>
#include <memory>
#include <fstream>

#include <cstdio>
#include <cstring>

struct RodataChunk {
  size_t offset;
  std::vector<unsigned char> data;
};

struct SymbolInfo {
  size_t address;
  size_t size;
  std::string name;
};

struct ProgramInfo {
  size_t rodataOffset;
  std::vector<RodataChunk> rodataChunks;
  std::vector<SymbolInfo> symbols;
};

std::unique_ptr<ProgramInfo> process(std::string image) {
  if (elf_version(EV_CURRENT) == EV_NONE) {
    fprintf(stderr, "Failed to init libelf.\n");
    return std::unique_ptr<ProgramInfo>(nullptr);
  }

  Elf *elf = elf_memory(&image[0], image.size());
  if (!elf) {
    fprintf(stderr, "elf_begin failed. (%s)\n", elf_errmsg(-1));
    return std::unique_ptr<ProgramInfo>(nullptr);
  }

  Elf_Kind elfKind = elf_kind(elf);
  if (elfKind != ELF_K_ELF) {
    fprintf(stderr, "Input is not an ELF object. (%d)\n", elfKind);
    return std::unique_ptr<ProgramInfo>(nullptr);
  }

  size_t numberOfSections;
  if (elf_getshdrnum(elf, &numberOfSections) != 0) {
    fprintf(stderr, "Failed to get number of ELF sections. (%s)\n", elf_errmsg(-1));
    return std::unique_ptr<ProgramInfo>(nullptr);
  }

  size_t sectionNameStringTableIndex;
  if (elf_getshdrstrndx(elf, &sectionNameStringTableIndex) != 0) {
    fprintf(stderr, "Failed to get ELF section names. (%s)\n", elf_errmsg(-1));
    return std::unique_ptr<ProgramInfo>(nullptr);
  }

  GElf_Off dataOffset;
  Elf_Scn *dataScn = nullptr;
  Elf_Scn *symbolTableScn = nullptr;
  Elf_Scn *stringTableScn = nullptr;

  for (size_t elfSectionIndex = 0; elfSectionIndex < numberOfSections; ++elfSectionIndex) {
    Elf_Scn *elfScn = elf_getscn(elf, elfSectionIndex);
    if (!elfScn) {
      fprintf(stderr, "Failed to get section %zu. (%s)\n", elfSectionIndex, elf_errmsg(-1));
      continue;
    }

    GElf_Shdr elfSectionHeader;
    if (gelf_getshdr(elfScn, &elfSectionHeader) != &elfSectionHeader) {
      fprintf(stderr, "Failed to get header for section %zu. (%s)\n", elfSectionIndex, elf_errmsg(-1));
      continue;
    }

    const char *name = elf_strptr(elf, sectionNameStringTableIndex, elfSectionHeader.sh_name);
    if (!name) {
      fprintf(stderr, "Failed to get name of section %zu. (%s)\n", elfSectionIndex, elf_errmsg(-1));
      continue;
    }

    if (elfSectionHeader.sh_type == SHT_SYMTAB && strcmp(name, ".symtab") == 0) {
      symbolTableScn = elfScn;
    } else if (elfSectionHeader.sh_type == SHT_STRTAB && strcmp(name, ".strtab") == 0) {
      stringTableScn = elfScn;
    } else if (elfSectionHeader.sh_type == SHT_PROGBITS && strcmp(name, ".rodata") == 0) {
      dataOffset = elfSectionHeader.sh_offset;
      dataScn = elfScn;
    }

    if (dataScn && symbolTableScn && stringTableScn) {
      break;
    }
  }

  if (!dataScn || !symbolTableScn || !stringTableScn) {
    fprintf(stderr, "Failed to find all required ELF sections.\n");
    return std::unique_ptr<ProgramInfo>(nullptr);
  }

  size_t symbolNameStringTableIndex = elf_ndxscn(stringTableScn);
  if (symbolNameStringTableIndex == SHN_UNDEF) {
    fprintf(stderr, "elf_ndxscn failed. (%s)\n", elf_errmsg(-1));
    return std::unique_ptr<ProgramInfo>(nullptr);
  }

  std::unique_ptr<ProgramInfo> programInfo(new ProgramInfo());
  programInfo->rodataOffset = dataOffset;

  Elf_Data *data = nullptr;
  while ((data = elf_getdata(dataScn, data)) != nullptr) {
    //fprintf(stderr, "Got a matching rodata segment: %08lx %08lx\n", dataOffset + data->d_off, data->d_size);
    RodataChunk rodataChunk;
    rodataChunk.offset = data->d_off;
    rodataChunk.data = std::move(std::vector<unsigned char>((char *)data->d_buf, (char *)data->d_buf + data->d_size));
    programInfo->rodataChunks.push_back(std::move(rodataChunk));

    //FILE *file = fopen("rodata.bin", "wb");
    //fwrite((char *)data->d_buf, 1, data->d_size, file);
    //fclose(file);
  }

  Elf_Data *symbolData = nullptr;
  while ((symbolData = elf_getdata(symbolTableScn, symbolData)) != nullptr) {
    size_t symbolIndex = 1;
    GElf_Sym symbol;
    while (gelf_getsym(symbolData, symbolIndex++, &symbol) != nullptr) {
      const char *name = elf_strptr(elf, symbolNameStringTableIndex, symbol.st_name);
      if (!name) {
        fprintf(stderr, "Failed to symbol name for %zu. (%s)\n", symbolIndex, elf_errmsg(-1));
        continue;
      }

      //fprintf(stdout, "%08lx %08lx %s\n", symbol.st_value, symbol.st_size, name);
      SymbolInfo symbolInfo;
      symbolInfo.address = symbol.st_value;
      symbolInfo.size = symbol.st_size;
      symbolInfo.name = name;
      programInfo->symbols.push_back(std::move(symbolInfo));
    }
  }

  elf_end(elf);
  return std::move(programInfo);
}

#ifdef EMSCRIPTEN
#include <emscripten/bind.h>

EMSCRIPTEN_BINDINGS(vtable) {
  emscripten::value_object<ProgramInfo>("ProgramInfo")
    .field("rodataOffset", &ProgramInfo::rodataOffset)
    .field("rodataChunks", &ProgramInfo::rodataChunks)
    .field("symbols", &ProgramInfo::symbols);

  emscripten::value_object<RodataChunk>("RodataChunk")
    .field("offset", &RodataChunk::offset)
    .field("data", &RodataChunk::data);

  emscripten::value_object<SymbolInfo>("SymbolInfo")
    .field("address", &SymbolInfo::address)
    .field("size", &SymbolInfo::size)
    .field("name", &SymbolInfo::name);

  emscripten::register_vector<unsigned char>("VectorUnsignedChar");
  emscripten::register_vector<RodataChunk>("VectorRodataChunk");
  emscripten::register_vector<SymbolInfo>("VectorSymbolInfo");

  emscripten::function("process", &process);
}
#else
int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "Usage: %s <file-name>\n", argv[0]);
    return 1;
  }

  std::ifstream file(argv[1], std::ios::binary);
  std::string image((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  std::unique_ptr<ProgramInfo> programInfo = process(image);

  if (!programInfo) {
    fprintf(stderr, "Failed to process input file '%s'.\n", argv[1]);
    return 1;
  }

  fprintf(stdout, "rodata offset: %08lx\n", programInfo->rodataOffset);
  fprintf(stdout, "rodata chunks: %lu\n", programInfo->rodataChunks.size());
  for (const auto &chunk : programInfo->rodataChunks) {
    fprintf(stdout, "  offset: %08lx\n", chunk.offset);
    fprintf(stdout, "    size: %lu\n", chunk.data.size());
  }

  fprintf(stdout, "symbols: %lu\n", programInfo->symbols.size());
  for (const auto &symbol : programInfo->symbols) {
    fprintf(stdout, "  offset: %08lx\n", symbol.address);
    fprintf(stdout, "    size: %lu\n", symbol.size);
    fprintf(stdout, "    name: %s\n", symbol.name.c_str());
  }

  return 0;
}
#endif
